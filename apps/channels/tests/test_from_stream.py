
from django.test import TestCase
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from rest_framework import status
from apps.channels.models import Channel, ChannelGroup, Stream, ChannelStream

User = get_user_model()

class ChannelFromStreamTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="testuser", password="testpass123")
        self.user.is_staff = True
        self.user.is_superuser = True
        self.user.save()
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)
        
        self.group = ChannelGroup.objects.create(name="Test Group")
        self.stream = Stream.objects.create(
            name="Test Stream", 
            stream_id="test_1", 
            channel_group=self.group,
            tvg_id="test_tvg"
        )

    def test_create_channel_from_stream_success(self):
        url = "/api/channels/channels/from-stream/"
        data = {
            "stream_id": self.stream.id,
            "channel_group_id": self.group.id
        }
        
        response = self.client.post(url, data, format='json')
        
        if response.status_code != status.HTTP_201_CREATED:
            print(f"Response error: {response.data}")
            
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Channel.objects.count(), 1)
        
        channel = Channel.objects.first()
        self.assertEqual(channel.name, "Test Stream")
        self.assertEqual(channel.channel_group, self.group)
        self.assertEqual(channel.streams.count(), 1)
        self.assertEqual(channel.streams.first(), self.stream)
