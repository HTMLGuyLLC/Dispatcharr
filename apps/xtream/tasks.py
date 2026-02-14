from celery import shared_task
from django.utils import timezone
from .models import XtreamAccount, ChannelGroupXtreamAccount
from apps.channels.models import Stream, ChannelGroup
from core.xtream_codes import Client as XCClient
from core.models import CoreSettings
import logging

logger = logging.getLogger(__name__)

@shared_task
def refresh_xtream_account(account_id):
    try:
        account = XtreamAccount.objects.get(id=account_id)
    except XtreamAccount.DoesNotExist:
        return

    # Skip if already syncing/disabled
    if account.status in [XtreamAccount.Status.SYNCING_LIVE, XtreamAccount.Status.SYNCING_VOD, XtreamAccount.Status.DISABLED]:
        # logger.warning(f"Account {account.name} is {account.status}, skipping refresh")
        # Forcing refresh might be desired by user, but let's be safe.
        # Actually, if user triggers API refresh, we might want to override. 
        # But for now, just logging.
        pass

    account.status = XtreamAccount.Status.SYNCING_LIVE
    account.save()

    try:
        sync_live_streams(account)
        
        if account.enable_vod:
            account.status = XtreamAccount.Status.SYNCING_VOD
            account.save()
            # sync_vod_content(account) # Placeholder for VOD sync
        
        account.status = XtreamAccount.Status.IDLE
        account.last_sync = timezone.now()
        account.last_error = None
        account.save()

    except Exception as e:
        logger.exception(f"Failed to refresh Xtream account {account.name}")
        account.status = XtreamAccount.Status.ERROR
        account.last_error = str(e)
        account.save()

def sync_live_streams(account):
    logger.info(f"Syncing live streams for {account.name}")
    try:
        with XCClient(account.server_url, account.username, account.password) as client:
            # 1. Fetch Categories
            categories = client.get_live_categories()
            
            # Map category_id to ChannelGroup
            category_map = {} # xc_id -> ChannelGroup
            
            for cat in categories:
                cat_id = str(cat['category_id'])
                cat_name = cat['category_name']
                
                # Create or get ChannelGroup
                group, created = ChannelGroup.objects.get_or_create(name=cat_name)
                
                # Link to Account
                cg_xa, _ = ChannelGroupXtreamAccount.objects.update_or_create(
                    channel_group=group,
                    xtream_account=account,
                    defaults={'xc_category_id': cat_id}
                )
                
                if cg_xa.enabled:
                    category_map[cat_id] = group

            # 2. Fetch Streams
            streams_data = client.get_all_live_streams()
            
            existing_streams = {
                s.stream_hash: s 
                for s in Stream.objects.filter(xtream_account=account)
            }
            
            seen_hashes = set()
            to_create = []
            to_update = []
            
            base_url = client._normalize_url(account.server_url)
            
            for stream_data in streams_data:
                cat_id = str(stream_data.get('category_id'))
                if cat_id not in category_map:
                    continue # Skip disabled categories
                    
                group = category_map[cat_id]
                stream_id = stream_data.get('stream_id')
                name = stream_data.get('name')
                
                # Construct URL
                stream_url = f"{base_url}/live/{account.username}/{account.password}/{stream_id}.ts"
                
                # Generate Hash
                stream_hash = Stream.generate_hash_key(
                    name=name,
                    url=stream_url,
                    tvg_id=stream_data.get('epg_channel_id'),
                    xtream_id=account.id,
                    stream_id=stream_id,
                    account_type='XTREAM',
                    keys=['url'] # 'url' is required for use_stream_id logic
                )
                 
                seen_hashes.add(stream_hash)
                
                defaults = {
                    'name': name,
                    'url': stream_url,
                    'channel_group': group,
                    'xtream_account': account,
                    'stream_id': stream_id,
                    'stream_chno': stream_data.get('num'),
                    'logo_url': stream_data.get('stream_icon'),
                    'is_stale': False,
                    'last_seen': timezone.now()
                }
                
                if stream_hash in existing_streams:
                    obj = existing_streams[stream_hash]
                    changed = False
                    for k, v in defaults.items():
                        if getattr(obj, k) != v:
                            setattr(obj, k, v)
                            changed = True
                    if changed:
                        to_update.append(obj)
                else:
                    defaults['stream_hash'] = stream_hash
                    to_create.append(Stream(**defaults))
            
            # Batch DB ops
            if to_create:
                Stream.objects.bulk_create(to_create, ignore_conflicts=True)
                logger.info(f"Created {len(to_create)} new streams")
                
            if to_update:
                Stream.objects.bulk_update(to_update, ['name', 'url', 'channel_group', 'logo_url', 'is_stale', 'last_seen', 'stream_chno'], batch_size=1000)
                logger.info(f"Updated {len(to_update)} existing streams")
                
            # Handle stale streams
            stale_ids = [s.id for h, s in existing_streams.items() if h not in seen_hashes]
            if stale_ids:
                 Stream.objects.filter(id__in=stale_ids).update(is_stale=True)
                 logger.info(f"Marked {len(stale_ids)} streams as stale")

    except Exception as e:
        logger.error(f"Error syncing live streams: {e}")
        raise e
