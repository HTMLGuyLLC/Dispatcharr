from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import XtreamAccount
from .serializers import XtreamAccountSerializer
from .tasks import refresh_xtream_account

class XtreamAccountViewSet(viewsets.ModelViewSet):
    queryset = XtreamAccount.objects.all().order_by('name')
    serializer_class = XtreamAccountSerializer

    @action(detail=True, methods=['post'])
    def refresh(self, request, pk=None):
        account = self.get_object()
        refresh_xtream_account.delay(account.id)
        return Response({'status': 'refresh started', 'message': f'Refresh started for {account.name}'})
