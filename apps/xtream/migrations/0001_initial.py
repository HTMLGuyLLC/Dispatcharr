from django.db import migrations, models
import django.db.models.deletion

class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('dispatcharr_channels', '0001_initial'),
        ('core', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='XtreamAccount',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255, unique=True)),
                ('server_url', models.URLField(max_length=1000)),
                ('username', models.CharField(max_length=255)),
                ('password', models.CharField(max_length=255)),
                ('max_streams', models.PositiveIntegerField(default=1, help_text='Maximum concurrent streams allowed (0 for unlimited)')),
                ('enable_vod', models.BooleanField(default=False, help_text='Enable VOD (Movie/Series) synchronization')),
                ('status', models.CharField(choices=[('idle', 'Idle'), ('syncing_live', 'Syncing Live'), ('syncing_vod', 'Syncing VOD'), ('error', 'Error'), ('disabled', 'Disabled')], default='idle', max_length=50)),
                ('last_sync', models.DateTimeField(blank=True, null=True)),
                ('last_error', models.TextField(blank=True, null=True)),
                ('is_active', models.BooleanField(default=True)),
                ('priority', models.IntegerField(default=0, help_text='Priority for channel/stream selection')),
                ('custom_properties', models.JSONField(blank=True, default=dict, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user_agent', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='xtream_accounts', to='core.useragent')),
            ],
        ),
        migrations.CreateModel(
            name='ChannelGroupXtreamAccount',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('xc_category_id', models.CharField(help_text='The Category ID from Xtream Codes API', max_length=255)),
                ('enabled', models.BooleanField(default=True)),
                ('auto_sync', models.BooleanField(default=False, help_text='Automatically Create/Delete channels based on this category')),
                ('custom_properties', models.JSONField(blank=True, default=dict, null=True)),
                ('channel_group', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='xtream_accounts', to='dispatcharr_channels.channelgroup')),
                ('xtream_account', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='channel_groups', to='xtream.xtreamaccount')),
            ],
            options={
                'indexes': [models.Index(fields=['xtream_account', 'xc_category_id'], name='xtream_chan_xtream__e984cc_idx')],
                'unique_together': {('channel_group', 'xtream_account')},
            },
        ),
    ]
