from rest_framework.routers import DefaultRouter
from .api_views import XtreamAccountViewSet

router = DefaultRouter()
router.register('accounts', XtreamAccountViewSet)

urlpatterns = router.urls
