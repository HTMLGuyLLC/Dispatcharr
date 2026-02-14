from django.db import migrations, models
import django.db.models.deletion

class Migration(migrations.Migration):

    dependencies = [
        ('dispatcharr_channels', '0034_remove_stream_dispatcharr_stream_id_idx_and_more'),
        ('xtream', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='stream',
            name='xtream_account',
            field=models.ForeignKey(blank=True, help_text='Associated Xtream Code Account', null=True, on_delete=django.db.models.deletion.CASCADE, related_name='streams', to='xtream.xtreamaccount'),
        ),
    ]
