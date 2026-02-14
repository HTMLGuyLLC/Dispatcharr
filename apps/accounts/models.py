# apps/accounts/models.py
from django.db import models
from django.contrib.auth.models import AbstractUser, Permission


class User(AbstractUser):
    """
    Custom user model for Dispatcharr.
    Inherits from Django's AbstractUser to add additional fields if needed.
    """

    class UserLevel(models.IntegerChoices):
        STREAMER = 0, "Streamer"
        STANDARD = 1, "Standard User"
        ADMIN = 10, "Admin"

    avatar_config = models.JSONField(default=dict, blank=True, null=True)
    channel_profiles = models.ManyToManyField(
        "dispatcharr_channels.ChannelProfile",
        blank=True,
        related_name="users",
    )
    user_level = models.IntegerField(default=UserLevel.STREAMER)
    custom_properties = models.JSONField(default=dict, blank=True, null=True)

    # Advanced User Management
    expires_at = models.DateTimeField(null=True, blank=True)
    connection_limit = models.PositiveIntegerField(default=1)

    def __str__(self):
        return self.username

    def get_groups(self):
        """
        Returns the groups (roles) the user belongs to.
        """
        return self.groups.all()

    def get_permissions(self):
        """
        Returns the permissions assigned to the user and their groups.
        """
        return self.user_permissions.all() | Permission.objects.filter(group__user=self)

    def sync_xc_account_info(self):
        """
        Synchronizes connection_limit and expires_at from the source XC server.
        Only runs if xc_passthrough_enabled is True.
        """
        custom_props = self.custom_properties or {}
        if not custom_props.get('xc_passthrough_enabled'):
            return False

        xc_password = custom_props.get('xc_password')
        if not xc_password:
            return False

        from core.xtream_codes import Client as XCClient
        from apps.xtream.models import XtreamAccount
        from apps.m3u.models import M3UAccount
        from apps.channels.models import Stream
        from datetime import datetime
        import logging

        logger = logging.getLogger(__name__)

        # Find a suitable XC-compatible server from the user's profiles
        source_server = None
        profile_ids = list(self.channel_profiles.values_list('id', flat=True))
        
        if profile_ids:
            # 1. Look for an XtreamAccount through streams in these profiles
            stream = Stream.objects.filter(
                channel_group__profile_groups__profile_id__in=profile_ids,
                xtream_account__isnull=False
            ).first()
            if stream:
                source_server = stream.xtream_account
            
            if not source_server:
                # 2. Look for an M3UAccount (type XC) through channels in these profiles
                stream = Stream.objects.filter(
                    channels__channelprofilemembership__channel_profile_id__in=profile_ids,
                    m3u_account__account_type="XC"
                ).first()
                if stream:
                    source_server = stream.m3u_account

        if not source_server:
            # Fallback to any active XC account
            source_server = XtreamAccount.objects.filter(status=XtreamAccount.Status.IDLE).first()
            if not source_server:
                source_server = M3UAccount.objects.filter(account_type="XC").first()

        if not source_server:
            logger.warning(f"No source XC server found to sync for user {self.username}")
            return False

        try:
            with XCClient(source_server.server_url, self.username, xc_password) as client:
                auth_data = client.authenticate()
                user_info = auth_data.get('user_info', {})
                
                max_connections = user_info.get('max_connections')
                exp_date_ts = user_info.get('exp_date')
                
                updated = False
                if max_connections is not None:
                    try:
                        max_cons = int(max_connections)
                        if self.connection_limit != max_cons:
                            self.connection_limit = max_cons
                            updated = True
                    except (ValueError, TypeError):
                        pass
                
                if exp_date_ts:
                    try:
                        exp_date = datetime.fromtimestamp(int(exp_date_ts))
                        # Use a small threshold for comparison to avoid floating point issues or timezone quirks
                        if not self.expires_at or abs((self.expires_at - exp_date).total_seconds()) > 60:
                            self.expires_at = exp_date
                            updated = True
                    except (ValueError, TypeError):
                        pass

                if updated:
                    self.save(update_fields=['connection_limit', 'expires_at'])
                    logger.info(f"Synchronized XC info for user {self.username} from {xtream_account.name}: limit={self.connection_limit}, exp={self.expires_at}")
                
                return True
        except Exception as e:
            logger.error(f"Failed to sync XC info for user {self.username}: {str(e)}")
            return False
