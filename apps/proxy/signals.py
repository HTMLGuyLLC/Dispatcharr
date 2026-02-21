from django.db.models.signals import pre_delete
from django.dispatch import receiver
from django.apps import apps
import logging

logger = logging.getLogger(__name__)

@receiver(pre_delete)
def cleanup_proxy_servers(sender, **kwargs):
    """Clean up proxy servers when Django shuts down"""
    try:
        proxy_app = apps.get_app_config('proxy')

        # Clean up TS proxy
        if hasattr(proxy_app, 'ts_proxy'):
            for channel_id in list(proxy_app.ts_proxy.stream_managers.keys()):
                proxy_app.ts_proxy.stop_channel(channel_id)

        # Clean up HLS output sessions
        try:
            from .hls_proxy.session_manager import HLSSessionManager
            manager = HLSSessionManager.get_instance()
            manager.shutdown()
        except Exception as e:
            logger.debug(f"HLS session manager cleanup: {e}")

        logger.info("Proxy servers cleaned up successfully")
    except Exception as e:
        logger.error(f"Error during proxy server cleanup: {e}")