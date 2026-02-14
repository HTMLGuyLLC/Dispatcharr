# Generated manually for channel organization UI enhancement

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("dispatcharr_channels", "0035_stream_xtream_account"),
    ]

    operations = [
        # Add image, sort_mode, and sort_field to ChannelGroup
        migrations.AddField(
            model_name="channelgroup",
            name="image",
            field=models.ForeignKey(
                blank=True,
                help_text="Custom image for the group (optional)",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="groups",
                to="dispatcharr_channels.logo",
            ),
        ),
        migrations.AddField(
            model_name="channelgroup",
            name="sort_mode",
            field=models.CharField(
                choices=[("manual", "Manual Order"), ("auto", "Auto Sort")],
                default="manual",
                help_text="How channels in this group are ordered",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="channelgroup",
            name="sort_field",
            field=models.CharField(
                blank=True,
                choices=[
                    ("channel_number_asc", "Channel Number (Ascending)"),
                    ("channel_number_desc", "Channel Number (Descending)"),
                    ("name_asc", "Name (A-Z)"),
                    ("name_desc", "Name (Z-A)"),
                ],
                help_text="Field to sort by when sort_mode is 'auto'",
                max_length=50,
                null=True,
            ),
        ),
        # Add created_by to ChannelProfile
        migrations.AddField(
            model_name="channelprofile",
            name="created_by",
            field=models.ForeignKey(
                blank=True,
                help_text="User who created this profile (for permission tracking)",
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="created_channel_profiles",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        # Update ChannelProfile name field max_length and add unique_together
        migrations.AlterField(
            model_name="channelprofile",
            name="name",
            field=models.CharField(max_length=255),
        ),
        migrations.AlterUniqueTogether(
            name="channelprofile",
            unique_together={("created_by", "name")},
        ),
    ]
