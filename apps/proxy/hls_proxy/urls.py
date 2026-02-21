from django.urls import path
from . import views

app_name = 'hls_proxy'

urlpatterns = [
    path('stream/<str:channel_id>', views.stream_hls, name='stream'),
    path('segments/<str:session_id>/<path:filename>', views.serve_segment, name='segment'),
]