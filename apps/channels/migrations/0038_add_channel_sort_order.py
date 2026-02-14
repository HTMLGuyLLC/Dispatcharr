from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('dispatcharr_channels', '0037_add_profile_group'),
    ]

    operations = [
        migrations.AddField(
            model_name='channel',
            name='sort_order',
            field=models.IntegerField(
                default=0,
                db_index=True,
                help_text="Manual sort order within the channel group (used when group sort_mode is 'manual')",
            ),
        ),
    ]
