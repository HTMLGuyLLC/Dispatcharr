import sys
from django.apps import AppConfig

class ProxyConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.proxy'
    verbose_name = "Stream Proxies"

    def ready(self):
        """Initialize proxy servers when Django starts"""
        if 'manage.py' not in sys.argv:
            from .ts_proxy.server import ProxyServer as TSProxyServer

            # Initialize TS proxy server
            self.ts_proxy = TSProxyServer()
