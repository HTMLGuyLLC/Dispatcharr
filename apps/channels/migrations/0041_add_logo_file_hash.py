# Generated manually

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('dispatcharr_channels', '0040_add_channel_is_hidden'),
    ]

    operations = [
        migrations.AddField(
            model_name='logo',
            name='file_hash',
            field=models.CharField(blank=True, db_index=True, help_text='SHA256 hash of file content for deduplication', max_length=64, null=True),
        ),
    ]
