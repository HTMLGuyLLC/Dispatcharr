from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('dispatcharr_channels', '0039_alter_channelgroup_sort_field_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='channel',
            name='is_hidden',
            field=models.BooleanField(
                default=False,
                db_index=True,
                help_text="Whether this channel is hidden from the outgoing feed (M3U/Xtream)",
            ),
        ),
    ]
