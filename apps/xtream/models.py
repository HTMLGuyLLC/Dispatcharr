from django.db import models
from core.models import UserAgent

class XtreamAccount(models.Model):
    class Status(models.TextChoices):
        IDLE = "idle", "Idle"
        SYNCING_LIVE = "syncing_live", "Syncing Live"
        SYNCING_VOD = "syncing_vod", "Syncing VOD"
        ERROR = "error", "Error"
        DISABLED = "disabled", "Disabled"

    name = models.CharField(max_length=255, unique=True)
    server_url = models.URLField(max_length=1000)
    username = models.CharField(max_length=255)
    password = models.CharField(max_length=255)
    
    user_agent = models.ForeignKey(
        UserAgent,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="xtream_accounts"
    )

    max_streams = models.PositiveIntegerField(default=1, help_text="Maximum concurrent streams allowed (0 for unlimited)")
    
    enable_vod = models.BooleanField(default=False, help_text="Enable VOD (Movie/Series) synchronization")
    
    status = models.CharField(
        max_length=50, 
        choices=Status.choices, 
        default=Status.IDLE
    )
    
    last_sync = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(null=True, blank=True)
    
    is_active = models.BooleanField(default=True)
    priority = models.IntegerField(default=0, help_text="Priority for channel/stream selection")
    
    custom_properties = models.JSONField(default=dict, blank=True, null=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name

class ChannelGroupXtreamAccount(models.Model):
    """
    Links a generic ChannelGroup to a specific Xtream Codes Category ID.
    This allows 'Sports' group to map to category_id='45' on one provider and '12' on another.
    """
    channel_group = models.ForeignKey(
        'dispatcharr_channels.ChannelGroup', 
        on_delete=models.CASCADE, 
        related_name='xtream_accounts'
    )
    xtream_account = models.ForeignKey(
        XtreamAccount, 
        on_delete=models.CASCADE, 
        related_name='channel_groups'
    )
    xc_category_id = models.CharField(max_length=255, help_text="The Category ID from Xtream Codes API")
    
    enabled = models.BooleanField(default=True)
    auto_sync = models.BooleanField(default=False, help_text="Automatically Create/Delete channels based on this category")
    
    custom_properties = models.JSONField(default=dict, blank=True, null=True)

    class Meta:
        unique_together = ('channel_group', 'xtream_account')
        indexes = [
            models.Index(fields=['xtream_account', 'xc_category_id']),
        ]

    def __str__(self):
        return f"{self.channel_group.name} -> {self.xtream_account.name} ({self.xc_category_id})"
