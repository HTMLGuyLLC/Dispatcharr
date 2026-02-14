from rest_framework import serializers
from .models import XtreamAccount, ChannelGroupXtreamAccount

class XtreamAccountSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=True, style={'input_type': 'password'})
    
    class Meta:
        model = XtreamAccount
        fields = '__all__'
        read_only_fields = ('status', 'last_sync', 'last_error', 'created_at', 'updated_at')
