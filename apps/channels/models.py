from django.db import models
from django.core.exceptions import ValidationError
from django.conf import settings
from core.models import StreamProfile, CoreSettings
from core.utils import RedisClient
import logging
import uuid
from datetime import datetime
import hashlib
import json
from apps.epg.models import EPGData
from apps.accounts.models import User

logger = logging.getLogger(__name__)

# If you have an M3UAccount model in apps.m3u, you can still import it:
from apps.m3u.models import M3UAccount


# Add fallback functions if Redis isn't available
def get_total_viewers(channel_id):
    """Get viewer count from Redis or return 0 if Redis isn't available"""
    redis_client = RedisClient.get_client()

    try:
        return int(redis_client.get(f"channel:{channel_id}:viewers") or 0)
    except Exception:
        return 0


class ChannelGroup(models.Model):
    name = models.TextField(unique=True, db_index=True)
    image = models.ForeignKey(
        'Logo',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='groups',
        help_text="Custom image for the group (optional)"
    )
    sort_mode = models.CharField(
        max_length=20,
        choices=[
            ('manual', 'Manual Order'),
            ('auto', 'Auto Sort')
        ],
        default='auto',
        help_text="How channels in this group are ordered"
    )
    sort_field = models.CharField(
        max_length=50,
        choices=[
            ('channel_number_asc', 'Channel Number (Ascending)'),
            ('channel_number_desc', 'Channel Number (Descending)'),
            ('name_asc', 'Name (A-Z)'),
            ('name_desc', 'Name (Z-A)'),
        ],
        default='name_asc',
        null=True,
        blank=True,
        help_text="Field to sort by when sort_mode is 'auto'"
    )

    def related_channels(self):
        # local import if needed to avoid cyc. Usually fine in a single file though
        return Channel.objects.filter(channel_group=self)

    def __str__(self):
        return self.name

    @classmethod
    def bulk_create_and_fetch(cls, objects):
        # Perform the bulk create operation
        cls.objects.bulk_create(objects)

        # Use a unique field to fetch the created objects (assuming 'name' is unique)
        created_objects = cls.objects.filter(name__in=[obj.name for obj in objects])

        return created_objects


class Stream(models.Model):
    """
    Represents a single stream (e.g. from an M3U source or custom URL).
    """

    name = models.CharField(max_length=255, default="Default Stream")
    url = models.URLField(max_length=4096, blank=True, null=True)
    m3u_account = models.ForeignKey(
        M3UAccount,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="streams",
    )
    xtream_account = models.ForeignKey(
        "xtream.XtreamAccount",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="streams",
        help_text="Associated Xtream Code Account",
    )
    logo_url = models.TextField(blank=True, null=True)
    tvg_id = models.CharField(max_length=255, blank=True, null=True)
    local_file = models.FileField(upload_to="uploads/", blank=True, null=True)
    current_viewers = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)
    channel_group = models.ForeignKey(
        ChannelGroup,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="streams",
    )
    stream_profile = models.ForeignKey(
        StreamProfile,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="streams",
    )
    is_custom = models.BooleanField(
        default=False,
        help_text="Whether this is a user-created stream or from an M3U account",
    )
    stream_hash = models.CharField(
        max_length=255,
        null=True,
        unique=True,
        help_text="Unique hash for this stream from the M3U account",
        db_index=True,
    )
    last_seen = models.DateTimeField(db_index=True, default=datetime.now)
    is_stale = models.BooleanField(
        default=False,
        db_index=True,
        help_text="Whether this stream is stale (not seen in recent refresh, pending deletion)"
    )
    is_adult = models.BooleanField(
        default=False,
        db_index=True,
        help_text="Whether this stream contains adult content"
    )
    custom_properties = models.JSONField(default=dict, blank=True, null=True)

    stream_id = models.IntegerField(
        null=True,
        blank=True,
        db_index=True,
        help_text="Provider stream ID (e.g., XC stream_id) for stable identity across credential changes"
    )
    stream_chno = models.FloatField(
        null=True,
        blank=True,
        db_index=True,
        help_text="Provider channel number (XC num or M3U tvg-chno) for ordering - supports decimals like 2.1"
    )

    # Stream statistics fields
    stream_stats = models.JSONField(
        null=True,
        blank=True,
        help_text="JSON object containing stream statistics like video codec, resolution, etc."
    )
    stream_stats_updated_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When stream statistics were last updated",
        db_index=True
    )

    class Meta:
        # If you use m3u_account, you might do unique_together = ('name','url','m3u_account')
        verbose_name = "Stream"
        verbose_name_plural = "Streams"
        ordering = ["-updated_at"]

    def __str__(self):
        return self.name or self.url or f"Stream ID {self.id}"

    @classmethod
    def generate_hash_key(cls, name, url, tvg_id, keys=None, m3u_id=None, group=None,
                          account_type=None, stream_id=None, xtream_id=None):
        if keys is None:
            keys = CoreSettings.get_m3u_hash_key().split(",")

        # For XC accounts, use stream_id instead of url when 'url' is in the hash keys
        # This ensures credential/URL changes don't break stream identity
        effective_url = url
        # Check for both 'XC' (legacy/M3U) and new 'XTREAM' account types
        use_stream_id = (account_type in ['XC', 'XTREAM']) and stream_id and 'url' in keys
        if use_stream_id:
            effective_url = stream_id

        stream_parts = {
            "name": name, 
            "url": effective_url, 
            "tvg_id": tvg_id, 
            "m3u_id": m3u_id, 
            "group": group,
            "xtream_id": xtream_id
        }

        hash_parts = {key: stream_parts[key] for key in keys if key in stream_parts}

        # When using stream_id instead of URL, we MUST include account ID to prevent
        # collisions across different accounts
        if use_stream_id:
            if m3u_id and 'm3u_id' not in hash_parts:
                hash_parts['m3u_id'] = m3u_id
            if xtream_id and 'xtream_id' not in hash_parts:
                hash_parts['xtream_id'] = xtream_id

        # Serialize and hash the dictionary
        serialized_obj = json.dumps(
            hash_parts, sort_keys=True
        )  # sort_keys ensures consistent ordering
        hash_object = hashlib.sha256(serialized_obj.encode())
        return hash_object.hexdigest()

    @classmethod
    def update_or_create_by_hash(cls, hash_value, **fields_to_update):
        try:
            # Try to find the Stream object with the given hash
            stream = cls.objects.get(stream_hash=hash_value)
            # If it exists, update the fields
            for field, value in fields_to_update.items():
                setattr(stream, field, value)
            stream.save()  # Save the updated object
            return stream, False  # False means it was updated, not created
        except cls.DoesNotExist:
            # If it doesn't exist, create a new object with the given hash
            fields_to_update["stream_hash"] = (
                hash_value  # Make sure the hash field is set
            )
            stream = cls.objects.create(**fields_to_update)
            return stream, True  # True means it was created

    def get_stream_profile(self):
        """
        Get the stream profile for this stream.
        Uses the stream's own profile if set, otherwise returns the default.
        """
        if self.stream_profile:
            return self.stream_profile

        stream_profile = StreamProfile.objects.get(
            id=CoreSettings.get_default_stream_profile_id()
        )

        return stream_profile

    def delete(self, *args, **kwargs):
        """
        Override delete to remove this stream from channels and delete channels
        that become empty (have no streams) after removal.
        """
        # Get all channels using this stream before deletion
        from django.db.models import Count
        
        channels_with_this_stream = list(self.channels.all())
        
        # Perform the actual stream deletion
        result = super().delete(*args, **kwargs)
        
        # Check each channel and delete if it has no streams left
        for channel in channels_with_this_stream:
            # Refresh from DB to get current stream count
            channel.refresh_from_db()
            stream_count = channel.streams.count()
            
            if stream_count == 0:
                channel.delete()
        
        return result


    def get_stream(self):
        """
        Finds an available stream for the requested channel and returns the selected stream and profile.
        """
        redis_client = RedisClient.get_client()
        profile_id = redis_client.get(f"stream_profile:{self.id}")
        if profile_id:
            profile_id = int(profile_id)
            return self.id, profile_id, None

        if self.xtream_account:
             xtream_account = self.xtream_account
             if not xtream_account.is_active:
                  return None, None, None

             # Simple connection check based on max_streams
             if xtream_account.max_streams > 0:
                 # Check current connections in Redis
                 # We need a key for the account connections
                 # Assuming reuse of profile-like keys or a new key structure
                 account_connections_key = f"xtream_account_connections:{xtream_account.id}"
                 current_connections = int(redis_client.get(account_connections_key) or 0)
                 
                 if current_connections >= xtream_account.max_streams:
                      return None, None, "Xtream Account stream limit reached"
                 
                 # Increment connection count
                 redis_client.incr(account_connections_key)
            
             # Start stream
             redis_client.set(f"channel_stream:{self.id}", self.id)
             # We store 0 or a dummy value for profile if none exists, or just don't set it if not used by Profile logic
             # But release_stream tries to read profile_id. 
             # We should probably handle release_stream logic for Xtream accounts too.
             # For now, let's mark it as profile -1 to indicate Xtream direct?
             redis_client.set(f"stream_profile:{self.id}", -1) 
             
             return self.id, -1, None


        # Retrieve the M3U account associated with the stream.
        m3u_account = self.m3u_account
        if not m3u_account:
            return None, None, None
            
        m3u_profiles = m3u_account.profiles.all()
        default_profile = next((obj for obj in m3u_profiles if obj.is_default), None)
        profiles = [default_profile] + [
            obj for obj in m3u_profiles if not obj.is_default
        ]

        for profile in profiles:
            logger.info(profile)
            # Skip inactive profiles
            if profile.is_active == False:
                continue

            profile_connections_key = f"profile_connections:{profile.id}"
            current_connections = int(redis_client.get(profile_connections_key) or 0)

            # Check if profile has available slots (or unlimited connections)
            if profile.max_streams == 0 or current_connections < profile.max_streams:
                # Start a new stream
                redis_client.set(f"channel_stream:{self.id}", self.id)
                redis_client.set(
                    f"stream_profile:{self.id}", profile.id
                )  # Store only the matched profile

                # Increment connection count for profiles with limits
                if profile.max_streams > 0:
                    redis_client.incr(profile_connections_key)

                return (
                    self.id,
                    profile.id,
                    None,
                )  # Return newly assigned stream and matched profile

        # 4. No available streams
        return None, None, None

    def release_stream(self):
        """
        Called when a stream is finished to release the lock.
        """
        redis_client = RedisClient.get_client()

        stream_id = self.id
        # Get the matched profile for cleanup
        profile_id = redis_client.get(f"stream_profile:{stream_id}")
        if not profile_id:
            logger.debug("Invalid profile ID pulled from stream index")
            return

        redis_client.delete(f"stream_profile:{stream_id}")  # Remove profile association

        profile_id = int(profile_id)
        
        # Handle Xtream Account release (encoded as -1)
        if profile_id == -1:
             if self.xtream_account and self.xtream_account.max_streams > 0:
                  account_connections_key = f"xtream_account_connections:{self.xtream_account.id}"
                  current = int(redis_client.get(account_connections_key) or 0)
                  if current > 0:
                       redis_client.decr(account_connections_key)
             logger.debug(f"Released Xtream stream {stream_id}")
             return

        logger.debug(
            f"Found profile ID {profile_id} associated with stream {stream_id}"
        )

        profile_connections_key = f"profile_connections:{profile_id}"

        # Only decrement if the profile had a max_connections limit
        current_count = int(redis_client.get(profile_connections_key) or 0)
        if current_count > 0:
            redis_client.decr(profile_connections_key)


class ChannelManager(models.Manager):
    def active(self):
        return self.all()


class Channel(models.Model):
    channel_number = models.FloatField(db_index=True)
    name = models.CharField(max_length=255)
    logo = models.ForeignKey(
        "Logo",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="channels",
    )

    # M2M to Stream now in the same file
    streams = models.ManyToManyField(
        Stream, blank=True, through="ChannelStream", related_name="channels"
    )

    channel_group = models.ForeignKey(
        "ChannelGroup",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="channels",
        help_text="Channel group this channel belongs to.",
    )
    tvg_id = models.CharField(max_length=255, blank=True, null=True)
    tvc_guide_stationid = models.CharField(max_length=255, blank=True, null=True)

    epg_data = models.ForeignKey(
        EPGData,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="channels",
    )

    stream_profile = models.ForeignKey(
        StreamProfile,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="channels",
    )

    uuid = models.UUIDField(
        default=uuid.uuid4, editable=False, unique=True, db_index=True
    )

    user_level = models.IntegerField(default=0)

    is_adult = models.BooleanField(
        default=False,
        db_index=True,
        help_text="Whether this channel contains adult content"
    )

    auto_created = models.BooleanField(
        default=False,
        help_text="Whether this channel was automatically created via M3U auto channel sync"
    )
    auto_created_by = models.ForeignKey(
        "m3u.M3UAccount",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="auto_created_channels",
        help_text="The M3U account that auto-created this channel"
    )

    created_at = models.DateTimeField(
        auto_now_add=True,
        help_text="Timestamp when this channel was created"
    )
    updated_at = models.DateTimeField(
        auto_now=True,
        help_text="Timestamp when this channel was last updated"
    )

    sort_order = models.IntegerField(
        default=0,
        db_index=True,
        help_text="Manual sort order within the channel group (used when group sort_mode is 'manual')"
    )

    is_hidden = models.BooleanField(
        default=False,
        db_index=True,
        help_text="Whether this channel is hidden from the outgoing feed (M3U/Xtream)"
    )


    def save(self, *args, **kwargs):
        # Auto-assign sort_order for new channels in manually-sorted groups
        if not self.pk and self.channel_group_id:
            try:
                group = ChannelGroup.objects.get(pk=self.channel_group_id)
                if group.sort_mode == 'manual':
                    max_order = Channel.objects.filter(
                        channel_group_id=self.channel_group_id
                    ).aggregate(models.Max('sort_order'))['sort_order__max']
                    self.sort_order = (max_order or 0) + 1
            except ChannelGroup.DoesNotExist:
                pass
        super().save(*args, **kwargs)

    def clean(self):
        # Enforce unique channel_number within a given group
        existing = Channel.objects.filter(
            channel_number=self.channel_number, channel_group=self.channel_group
        ).exclude(id=self.id)
        if existing.exists():
            raise ValidationError(
                f"Channel number {self.channel_number} already exists in group {self.channel_group}."
            )

    def __str__(self):
        return f"{self.channel_number} - {self.name}"

    @classmethod
    def get_next_available_channel_number(cls, starting_from=1):
        used_numbers = set(cls.objects.all().values_list("channel_number", flat=True))
        n = starting_from
        while n in used_numbers:
            n += 1
        return n

    # @TODO: honor stream's stream profile
    def get_stream_profile(self):
        stream_profile = self.stream_profile
        if not stream_profile:
            stream_profile = StreamProfile.objects.get(
                id=CoreSettings.get_default_stream_profile_id()
            )

        return stream_profile

    def get_stream(self):
        """
        Finds an available stream for the requested channel and returns the selected stream and profile.

        Returns:
            Tuple[Optional[int], Optional[int], Optional[str]]: (stream_id, profile_id, error_reason)
        """
        redis_client = RedisClient.get_client()
        error_reason = None

        # Check if this channel has any streams
        if not self.streams.exists():
            error_reason = "No streams assigned to channel"
            return None, None, error_reason

        # Check if a stream is already active for this channel
        stream_id_bytes = redis_client.get(f"channel_stream:{self.id}")
        if stream_id_bytes:
            try:
                stream_id = int(stream_id_bytes)
                profile_id_bytes = redis_client.get(f"stream_profile:{stream_id}")
                if profile_id_bytes:
                    try:
                        profile_id = int(profile_id_bytes)
                        return stream_id, profile_id, None
                    except (ValueError, TypeError):
                        logger.debug(
                            f"Invalid profile ID retrieved from Redis: {profile_id_bytes}"
                        )
            except (ValueError, TypeError):
                logger.debug(
                    f"Invalid stream ID retrieved from Redis: {stream_id_bytes}"
                )

        # No existing active stream, attempt to assign a new one
        has_streams_but_maxed_out = False
        has_active_profiles = False

        # Iterate through channel streams and their profiles
        for stream in self.streams.all().order_by("channelstream__order"):
            # Retrieve the M3U account associated with the stream.
            m3u_account = stream.m3u_account
            if not m3u_account:
                logger.debug(f"Stream {stream.id} has no M3U account")
                continue
            if m3u_account.is_active == False:
                logger.debug(f"M3U account {m3u_account.id} is inactive, skipping.")
                continue

            m3u_profiles = m3u_account.profiles.filter(is_active=True)
            default_profile = next(
                (obj for obj in m3u_profiles if obj.is_default), None
            )

            if not default_profile:
                logger.debug(f"M3U account {m3u_account.id} has no active default profile")
                continue

            profiles = [default_profile] + [
                obj for obj in m3u_profiles if not obj.is_default
            ]

            for profile in profiles:
                has_active_profiles = True

                profile_connections_key = f"profile_connections:{profile.id}"
                current_connections = int(
                    redis_client.get(profile_connections_key) or 0
                )

                # Check if profile has available slots (or unlimited connections)
                if (
                    profile.max_streams == 0
                    or current_connections < profile.max_streams
                ):
                    # Start a new stream
                    redis_client.set(f"channel_stream:{self.id}", stream.id)
                    redis_client.set(f"stream_profile:{stream.id}", profile.id)

                    # Increment connection count for profiles with limits
                    if profile.max_streams > 0:
                        redis_client.incr(profile_connections_key)

                    return (
                        stream.id,
                        profile.id,
                        None,
                    )  # Return newly assigned stream and matched profile
                else:
                    # This profile is at max connections
                    has_streams_but_maxed_out = True
                    logger.debug(
                        f"Profile {profile.id} at max connections: {current_connections}/{profile.max_streams}"
                    )

        # No available streams - determine specific reason
        if has_streams_but_maxed_out:
            error_reason = "All active M3U profiles have reached maximum connection limits"
        elif has_active_profiles:
            error_reason = "No compatible active profile found for any assigned stream"
        else:
            error_reason = "No active profiles found for any assigned stream"

        return None, None, error_reason

    def release_stream(self):
        """
        Called when a stream is finished to release the lock.
        """
        redis_client = RedisClient.get_client()

        stream_id = redis_client.get(f"channel_stream:{self.id}")
        if not stream_id:
            logger.debug("Invalid stream ID pulled from channel index")
            return

        redis_client.delete(f"channel_stream:{self.id}")  # Remove active stream

        stream_id = int(stream_id)
        logger.debug(
            f"Found stream ID {stream_id} associated with channel stream {self.id}"
        )

        # Get the matched profile for cleanup
        profile_id = redis_client.get(f"stream_profile:{stream_id}")
        if not profile_id:
            logger.debug("Invalid profile ID pulled from stream index")
            return

        redis_client.delete(f"stream_profile:{stream_id}")  # Remove profile association

        profile_id = int(profile_id)
        logger.debug(
            f"Found profile ID {profile_id} associated with stream {stream_id}"
        )

        profile_connections_key = f"profile_connections:{profile_id}"

        # Only decrement if the profile had a max_connections limit
        current_count = int(redis_client.get(profile_connections_key) or 0)
        if current_count > 0:
            redis_client.decr(profile_connections_key)

    def update_stream_profile(self, new_profile_id):
        """
        Updates the profile for the current stream and adjusts connection counts.

        Args:
            new_profile_id: The ID of the new stream profile to use

        Returns:
            bool: True if successful, False otherwise
        """
        redis_client = RedisClient.get_client()

        # Get current stream ID
        stream_id_bytes = redis_client.get(f"channel_stream:{self.id}")
        if not stream_id_bytes:
            logger.debug("No active stream found for channel")
            return False

        stream_id = int(stream_id_bytes)

        # Get current profile ID
        current_profile_id_bytes = redis_client.get(f"stream_profile:{stream_id}")
        if not current_profile_id_bytes:
            logger.debug("No profile found for current stream")
            return False

        current_profile_id = int(current_profile_id_bytes)

        # Don't do anything if the profile is already set to the requested one
        if current_profile_id == new_profile_id:
            return True

        # Decrement connection count for old profile
        old_profile_connections_key = f"profile_connections:{current_profile_id}"
        old_count = int(redis_client.get(old_profile_connections_key) or 0)
        if old_count > 0:
            redis_client.decr(old_profile_connections_key)

        # Update the profile mapping
        redis_client.set(f"stream_profile:{stream_id}", new_profile_id)

        # Increment connection count for new profile
        new_profile_connections_key = f"profile_connections:{new_profile_id}"
        redis_client.incr(new_profile_connections_key)
        logger.info(
            f"Updated stream {stream_id} profile from {current_profile_id} to {new_profile_id}"
        )
        return True


class ChannelProfile(models.Model):
    name = models.CharField(max_length=255)
    created_by = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='created_channel_profiles',
        null=True,
        blank=True,
        help_text="User who created this profile (for permission tracking)"
    )

    class Meta:
        unique_together = ("created_by", "name")


class ChannelProfileMembership(models.Model):
    channel_profile = models.ForeignKey(ChannelProfile, on_delete=models.CASCADE)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE)
    enabled = models.BooleanField(
        default=True
    )  # Track if the channel is enabled for this group

    class Meta:
        unique_together = ("channel_profile", "channel")


class ProfileGroup(models.Model):
    """
    Links a ChannelProfile to a ChannelGroup.
    Groups in this table are the ones shown in the organizer's left panel
    for a specific profile. Source/M3U groups not linked here only appear
    in the stream library (right panel).
    """
    profile = models.ForeignKey(
        ChannelProfile,
        on_delete=models.CASCADE,
        related_name='profile_groups',
    )
    channel_group = models.ForeignKey(
        ChannelGroup,
        on_delete=models.CASCADE,
        related_name='profile_groups',
    )
    order = models.PositiveIntegerField(
        default=0,
        help_text="Display order of this group within the profile"
    )
    is_active = models.BooleanField(
        default=True,
        help_text="Whether this group is active/visible in the profile"
    )

    class Meta:
        unique_together = ("profile", "channel_group")
        ordering = ["order"]

    def __str__(self):
        return f"{self.profile.name} - {self.channel_group.name} (order={self.order}, active={self.is_active})"


class ChannelStream(models.Model):
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE)
    stream = models.ForeignKey(Stream, on_delete=models.CASCADE)
    order = models.PositiveIntegerField(default=0)  # Ordering field

    class Meta:
        ordering = ["order"]  # Ensure streams are retrieved in order
        constraints = [
            models.UniqueConstraint(
                fields=["channel", "stream"], name="unique_channel_stream"
            )
        ]


class ChannelGroupM3UAccount(models.Model):
    channel_group = models.ForeignKey(
        ChannelGroup, on_delete=models.CASCADE, related_name="m3u_accounts"
    )
    m3u_account = models.ForeignKey(
        M3UAccount, on_delete=models.CASCADE, related_name="channel_group"
    )
    custom_properties = models.JSONField(default=dict, blank=True, null=True)
    enabled = models.BooleanField(default=True)
    auto_channel_sync = models.BooleanField(
        default=False,
        help_text='Automatically create/delete channels to match streams in this group'
    )
    auto_sync_channel_start = models.FloatField(
        null=True,
        blank=True,
        help_text='Starting channel number for auto-created channels in this group'
    )
    last_seen = models.DateTimeField(
        default=datetime.now,
        db_index=True,
        help_text='Last time this group was seen in the M3U source during a refresh'
    )
    is_stale = models.BooleanField(
        default=False,
        db_index=True,
        help_text='Whether this group relationship is stale (not seen in recent refresh, pending deletion)'
    )

    class Meta:
        unique_together = ("channel_group", "m3u_account")

    def __str__(self):
        return f"{self.channel_group.name} - {self.m3u_account.name} (Enabled: {self.enabled})"


class Logo(models.Model):
    name = models.CharField(max_length=255)
    url = models.TextField(unique=True)
    file_hash = models.CharField(max_length=64, null=True, blank=True, db_index=True, help_text="SHA256 hash of file content for deduplication")

    def __str__(self):
        return self.name


class Recording(models.Model):
    channel = models.ForeignKey(
        "Channel", on_delete=models.CASCADE, related_name="recordings"
    )
    start_time = models.DateTimeField()
    end_time = models.DateTimeField()
    task_id = models.CharField(max_length=255, null=True, blank=True)
    custom_properties = models.JSONField(default=dict, blank=True, null=True)

    def __str__(self):
        return f"{self.channel.name} - {self.start_time} to {self.end_time}"


class RecurringRecordingRule(models.Model):
    """Rule describing a recurring manual DVR schedule."""

    channel = models.ForeignKey(
        "Channel",
        on_delete=models.CASCADE,
        related_name="recurring_rules",
    )
    days_of_week = models.JSONField(default=list)
    start_time = models.TimeField()
    end_time = models.TimeField()
    enabled = models.BooleanField(default=True)
    name = models.CharField(max_length=255, blank=True)
    start_date = models.DateField(null=True, blank=True)
    end_date = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["channel", "start_time"]

    def __str__(self):
        channel_name = getattr(self.channel, "name", str(self.channel_id))
        return f"Recurring rule for {channel_name}"

    def cleaned_days(self):
        try:
            return sorted({int(d) for d in (self.days_of_week or []) if 0 <= int(d) <= 6})
        except Exception:
            return []
