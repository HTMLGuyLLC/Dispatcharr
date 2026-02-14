from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('dispatcharr_channels', '0036_add_group_image_and_sort_settings'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProfileGroup',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('order', models.PositiveIntegerField(default=0, help_text='Display order of this group within the profile')),
                ('is_active', models.BooleanField(default=True, help_text='Whether this group is active/visible in the profile')),
                ('channel_group', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='profile_groups', to='dispatcharr_channels.channelgroup')),
                ('profile', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='profile_groups', to='dispatcharr_channels.channelprofile')),
            ],
            options={
                'ordering': ['order'],
                'unique_together': {('profile', 'channel_group')},
            },
        ),
    ]
