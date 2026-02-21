from rest_framework import viewsets, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from drf_spectacular.utils import extend_schema, OpenApiParameter, inline_serializer
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers
from django.shortcuts import get_object_or_404, get_list_or_404
from django.db import transaction
from django.db.models import Count, F
from django.db.models import Q
import os, json, requests, logging, mimetypes
from django.utils.http import http_date
from urllib.parse import unquote
from apps.accounts.permissions import (
    Authenticated,
    IsAdmin,
    IsOwnerOfObject,
    permission_classes_by_action,
    permission_classes_by_method,
)

from core.models import UserAgent, CoreSettings
from core.utils import RedisClient

from .models import (
    Stream,
    Channel,
    ChannelGroup,
    Logo,
    ChannelProfile,
    ChannelProfileMembership,
    ProfileGroup,
    Recording,
    RecurringRecordingRule,
    ChannelStream,
)
from .serializers import (
    StreamSerializer,
    ChannelSerializer,
    ChannelGroupSerializer,
    LogoSerializer,
    ChannelProfileMembershipSerializer,
    BulkChannelProfileMembershipSerializer,
    ChannelProfileSerializer,
    ProfileGroupSerializer,
    RecordingSerializer,
    RecurringRecordingRuleSerializer,
)
from .tasks import (
    match_epg_channels,
    evaluate_series_rules,
    evaluate_series_rules_impl,
    match_single_channel_epg,
    match_selected_channels_epg,
    sync_recurring_rule_impl,
    purge_recurring_rule_impl,
    create_profile_from_source_task,
)
import django_filters
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter, OrderingFilter
from apps.epg.models import EPGData
from apps.vod.models import Movie, Series
from django.db.models import Q
from django.http import StreamingHttpResponse, FileResponse, Http404
from django.utils import timezone
import mimetypes
from django.conf import settings

from rest_framework.pagination import PageNumberPagination



logger = logging.getLogger(__name__)


class OrInFilter(django_filters.Filter):
    """
    Custom filter that handles the OR condition instead of AND.
    """

    def filter(self, queryset, value):
        if value:
            # Create a Q object for each value and combine them with OR
            query = Q()
            for val in value.split(","):
                query |= Q(**{self.field_name: val})
            return queryset.filter(query)
        return queryset


class StreamPagination(PageNumberPagination):
    page_size = 50  # Default page size to match frontend default
    page_size_query_param = "page_size"  # Allow clients to specify page size
    max_page_size = 5000  # Must be >= frontend batch sync size (StreamLibraryPanel)

    def paginate_queryset(self, queryset, request, view=None):
        if not request.query_params.get(self.page_query_param):
            return None  # disables pagination, returns full queryset

        return super().paginate_queryset(queryset, request, view)


class StreamFilter(django_filters.FilterSet):
    name = django_filters.CharFilter(lookup_expr="icontains")
    channel_group_name = OrInFilter(
        field_name="channel_group__name", lookup_expr="icontains"
    )
    m3u_account = django_filters.BaseInFilter(field_name="m3u_account__id")
    m3u_account_name = django_filters.CharFilter(
        field_name="m3u_account__name", lookup_expr="icontains"
    )
    m3u_account_is_active = django_filters.BooleanFilter(
        field_name="m3u_account__is_active"
    )
    xtream_account = django_filters.BaseInFilter(field_name="xtream_account__id")
    xtream_account_name = django_filters.CharFilter(
        field_name="xtream_account__name", lookup_expr="icontains"
    )
    xtream_account_is_active = django_filters.BooleanFilter(
        field_name="xtream_account__is_active"
    )
    tvg_id = django_filters.CharFilter(lookup_expr="icontains")

    class Meta:
        model = Stream
        fields = [
            "name",
            "channel_group_name",
            "m3u_account",
            "m3u_account_name",
            "m3u_account_is_active",
            "xtream_account",
            "xtream_account_name",
            "xtream_account_is_active",
            "tvg_id",
        ]


# ─────────────────────────────────────────────────────────
# 1) Stream API (CRUD)
# ─────────────────────────────────────────────────────────
class StreamViewSet(viewsets.ModelViewSet):
    queryset = Stream.objects.all()
    serializer_class = StreamSerializer
    pagination_class = StreamPagination

    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class = StreamFilter
    search_fields = ["name", "channel_group__name"]
    ordering_fields = ["name", "channel_group__name", "m3u_account__name", "tvg_id"]
    ordering = ["-name"]

    def get_permissions(self):
        if self.action == "duplicate":
            return [IsAdmin()]
        try:
            return [perm() for perm in permission_classes_by_action[self.action]]
        except KeyError:
            return [Authenticated()]

    def get_queryset(self):
        qs = super().get_queryset().select_related("m3u_account", "xtream_account", "channel_group", "stream_profile")
        # Exclude streams from inactive M3U accounts and inactive Xtream accounts
        qs = qs.exclude(m3u_account__is_active=False).exclude(xtream_account__is_active=False)

        assigned = self.request.query_params.get("assigned")
        if assigned is not None:
            qs = qs.filter(channels__id=assigned)

        unassigned = self.request.query_params.get("unassigned")
        if unassigned and str(unassigned).lower() in ("1", "true", "yes", "on"):
            # Use annotation with Count for better performance on large datasets
            qs = qs.annotate(channel_count=Count('channels')).filter(channel_count=0)

        channel_group = self.request.query_params.get("channel_group")
        if channel_group:
            group_names = channel_group.split(",")
            qs = qs.filter(channel_group__name__in=group_names)

        # Allow client to hide stale streams (streams marked as is_stale=True)
        hide_stale = self.request.query_params.get("hide_stale")
        if hide_stale and str(hide_stale).lower() in ("1", "true", "yes", "on"):
            qs = qs.filter(is_stale=False)

        return qs

    def list(self, request, *args, **kwargs):
        ids = request.query_params.get("ids", None)
        if ids:
            ids = ids.split(",")
            streams = get_list_or_404(Stream, id__in=ids)
            serializer = self.get_serializer(streams, many=True)
            return Response(serializer.data)

        return super().list(request, *args, **kwargs)

    @action(detail=False, methods=["get"], url_path="ids")
    def get_ids(self, request, *args, **kwargs):
        # Get the filtered queryset
        queryset = self.get_queryset()

        # Apply filtering, search, and ordering
        queryset = self.filter_queryset(queryset)

        # Return only the IDs from the queryset
        stream_ids = queryset.values_list("id", flat=True)

        # Return the response with the list of IDs
        return Response(list(stream_ids))

    @action(detail=False, methods=["get"], url_path="groups")
    def get_groups(self, request, *args, **kwargs):
        # Get unique ChannelGroup names that are linked to streams
        group_names = (
            ChannelGroup.objects.filter(streams__isnull=False)
            .order_by("name")
            .values_list("name", flat=True)
            .distinct()
        )

        # Return the response with the list of unique group names
        return Response(list(group_names))

    @action(detail=False, methods=["get"], url_path="filter-options")
    def get_filter_options(self, request, *args, **kwargs):
        """
        Get available filter options based on current filter state.
        Uses a hierarchical approach: M3U is the parent filter, Group filters based on M3U.
        """
        # For group options: we need to bypass the channel_group custom queryset filtering
        # Store original request params
        original_params = request.query_params

        # Create modified params without channel_group for getting group options
        params_without_group = request.GET.copy()
        params_without_group.pop('channel_group', None)
        params_without_group.pop('channel_group_name', None)

        # Temporarily modify request to exclude channel_group
        request._request.GET = params_without_group
        base_queryset_for_groups = self.get_queryset()

        # Apply filterset (which will apply M3U filters)
        group_filterset = self.filterset_class(
            params_without_group,
            queryset=base_queryset_for_groups
        )
        group_queryset = group_filterset.qs

        group_names = (
            group_queryset.exclude(channel_group__isnull=True)
            .order_by("channel_group__name")
            .values_list("channel_group__name", flat=True)
            .distinct()
        )

        # For M3U options: show ALL M3Us (don't filter by anything except name search)
        params_for_m3u = request.GET.copy()
        params_for_m3u.pop('m3u_account', None)
        params_for_m3u.pop('channel_group', None)
        params_for_m3u.pop('channel_group_name', None)

        # Temporarily modify request to exclude filters for M3U options
        request._request.GET = params_for_m3u
        base_queryset_for_m3u = self.get_queryset()

        m3u_filterset = self.filterset_class(
            params_for_m3u,
            queryset=base_queryset_for_m3u
        )
        m3u_queryset = m3u_filterset.qs

        m3u_accounts = (
            m3u_queryset.exclude(m3u_account__isnull=True)
            .order_by("m3u_account__name")
            .values("m3u_account__id", "m3u_account__name")
            .distinct()
        )

        # For Xtream options
        params_for_xtream = request.GET.copy()
        params_for_xtream.pop('xtream_account', None)
        params_for_xtream.pop('channel_group', None)
        params_for_xtream.pop('channel_group_name', None)

        request._request.GET = params_for_xtream
        base_queryset_for_xtream = self.get_queryset()

        xtream_filterset = self.filterset_class(
            params_for_xtream,
            queryset=base_queryset_for_xtream
        )
        xtream_queryset = xtream_filterset.qs

        xtream_accounts = (
            xtream_queryset.exclude(xtream_account__isnull=True)
            .order_by("xtream_account__name")
            .values("xtream_account__id", "xtream_account__name")
            .distinct()
        )

        # Restore original params
        request._request.GET = original_params

        return Response({
            "groups": list(group_names),
            "m3u_accounts": [
                {"id": m3u["m3u_account__id"], "name": m3u["m3u_account__name"]}
                for m3u in m3u_accounts
            ],
            "xtream_accounts": [
                {"id": xc["xtream_account__id"], "name": xc["xtream_account__name"]}
                for xc in xtream_accounts
            ]
        })

    @extend_schema(
        methods=["POST"],
        description="Retrieve streams by a list of IDs using POST to avoid URL length limitations",
        request=inline_serializer(
            name="StreamByIdsRequest",
            fields={
                "ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="List of stream IDs to retrieve"
                ),
            },
        ),
        responses={200: StreamSerializer(many=True)},
    )
    @action(detail=False, methods=["post"], url_path="by-ids")
    def get_by_ids(self, request, *args, **kwargs):
        ids = request.data.get("ids", [])
        if not isinstance(ids, list):
            return Response(
                {"error": "ids must be a list of integers"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        streams = Stream.objects.filter(id__in=ids)
        serializer = self.get_serializer(streams, many=True)
        return Response(serializer.data)

    @extend_schema(
        methods=["GET"],
        description="Check if a stream is used in any channels",
        responses={
            200: inline_serializer(
                name="StreamUsageResponse",
                fields={
                    "is_used": serializers.BooleanField(),
                    "channel_count": serializers.IntegerField(),
                    "channels": serializers.ListField(
                        child=inline_serializer(
                            name="ChannelUsageInfo",
                            fields={
                                "id": serializers.IntegerField(),
                                "name": serializers.CharField(),
                                "channel_number": serializers.IntegerField(),
                            }
                        )
                    ),
                },
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="check-usage")
    def check_usage(self, request, pk=None):
        """Check if this stream is used in any channels"""
        stream = self.get_object()
        
        # Efficient query to get channels using this stream
        from django.db.models import Count
        
        channels_using_stream = Channel.objects.filter(
            streams=stream
        ).annotate(
            stream_count=Count('streams')
        ).values('id', 'name', 'channel_number', 'stream_count')[:10]
        
        channel_list = list(channels_using_stream)
        total_count = Channel.objects.filter(streams=stream).count()
        
        # Identify channels that will be deleted (only have this one stream)
        channels_to_delete = Channel.objects.filter(
            streams=stream
        ).annotate(
            stream_count=Count('streams')
        ).filter(stream_count=1).values('id', 'name', 'channel_number')[:10]
        
        channels_to_delete_list = list(channels_to_delete)
        total_channels_to_delete = Channel.objects.filter(
            streams=stream
        ).annotate(
            stream_count=Count('streams')
        ).filter(stream_count=1).count()
        
        return Response({
            "is_used": total_count > 0,
            "channel_count": total_count,
            "channels": channel_list,
            "channels_to_delete": channels_to_delete_list,
            "channels_to_delete_count": total_channels_to_delete,
        })

    @action(detail=False, methods=["get"], url_path="bulk-sync")
    def bulk_sync(self, request, *args, **kwargs):
        """
        Lightweight endpoint for syncing streams to the frontend local DB.
        Returns only the fields needed for display/search in the Stream Library,
        bypassing the full serializer for maximum speed.
        """
        page = int(request.query_params.get("page", 1))
        page_size = min(int(request.query_params.get("page_size", 5000)), 10000)

        qs = self.get_queryset().only(
            "id", "name", "channel_group_id", "m3u_account_id",
            "xtream_account_id", "tvg_id", "stream_hash", "custom_properties"
        )

        total = qs.count()
        start = (page - 1) * page_size
        end = start + page_size

        streams = list(
            qs[start:end].values(
                "id", "name", "tvg_id", "stream_hash", "custom_properties",
                "channel_group_id", "m3u_account_id", "xtream_account_id",
            )
        )
        # Rename _id keys to match frontend expectations
        for s in streams:
            s["channel_group"] = s.pop("channel_group_id")
            s["m3u_account"] = s.pop("m3u_account_id")
            s["xtream_account"] = s.pop("xtream_account_id")

        return Response({
            "count": total,
            "results": streams,
        })



# ─────────────────────────────────────────────────────────
# 2) Channel Group Management (CRUD)
# ─────────────────────────────────────────────────────────
class ChannelGroupViewSet(viewsets.ModelViewSet):
    queryset = ChannelGroup.objects.all()
    serializer_class = ChannelGroupSerializer

    def get_permissions(self):
        try:
            return [perm() for perm in permission_classes_by_action[self.action]]
        except KeyError:
            return [Authenticated()]

    def get_queryset(self):
        """Return channel groups with prefetched relations for efficient counting"""
        return ChannelGroup.objects.prefetch_related('channels', 'm3u_accounts').all()

    def update(self, request, *args, **kwargs):
        """Override update to check M3U associations"""
        instance = self.get_object()

        # Check if group has M3U account associations
        if hasattr(instance, 'm3u_account') and instance.m3u_account.exists():
            return Response(
                {"error": "Cannot edit group with M3U account associations"},
                status=status.HTTP_400_BAD_REQUEST
            )

        return super().update(request, *args, **kwargs)

    def partial_update(self, request, *args, **kwargs):
        """Override partial_update to check M3U associations.
        Sort settings (sort_mode, sort_field) are always allowed.
        """
        instance = self.get_object()
        sort_only_fields = {'sort_mode', 'sort_field'}
        request_fields = set(request.data.keys())

        # If updating only sort settings, allow it even for M3U-associated groups
        if not request_fields.issubset(sort_only_fields):
            if hasattr(instance, 'm3u_account') and instance.m3u_account.exists():
                return Response(
                    {"error": "Cannot edit group with M3U account associations (sort settings are allowed)"},
                    status=status.HTTP_400_BAD_REQUEST
                )

        return super().partial_update(request, *args, **kwargs)

    @extend_schema(
        request=inline_serializer(
            'ChannelGroupSetImageRequest',
            fields={'image_file': serializers.ImageField()}
        ),
        responses={200: ChannelGroupSerializer}
    )
    @action(detail=True, methods=['post'], url_path='set-image')
    def set_image(self, request, pk=None):
        """Upload and set a custom image for the group"""
        from .models import Logo
        
        group = self.get_object()
        image_file = request.FILES.get('image_file')
        
        if not image_file:
            return Response(
                {'error': 'image_file is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Create or update Logo entry
        logo = Logo.objects.create(url=image_file)
        group.image = logo
        group.save()
        
        serializer = self.get_serializer(group)
        return Response(serializer.data)

    @extend_schema(responses={200: ChannelGroupSerializer})
    @action(detail=True, methods=['delete'], url_path='remove-image')
    def remove_image(self, request, pk=None):
        """Remove the custom image from the group"""
        group = self.get_object()
        group.image = None
        group.save()
        
        serializer = self.get_serializer(group)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='clear-channels')
    def clear_channels(self, request, pk=None):
        """Delete all channels belonging to this group."""
        group = self.get_object()
        from apps.channels.models import Channel
        count, _ = Channel.objects.filter(channel_group=group).delete()
        return Response({'message': f'Cleared {count} channels from group {group.name}'})

    @extend_schema(
        responses={
            200: inline_serializer(
                'ChannelGroupStatsResponse',
                fields={
                    'groups': serializers.ListField(
                        child=inline_serializer(
                            'GroupStats',
                            fields={
                                'id': serializers.IntegerField(),
                                'name': serializers.CharField(),
                                'channel_count': serializers.IntegerField(),
                                'epg_coverage_percent': serializers.FloatField(),
                                'has_stale_channels': serializers.BooleanField()
                            }
                        )
                    )
                }
            )
        }
    )
    @action(detail=False, methods=['get'], url_path='stats')
    def stats(self, request):
        """Get statistics for all channel groups"""
        from django.db.models import Count, Q
        
        groups = ChannelGroup.objects.annotate(
            channel_count=Count('channels'),
            channels_with_epg=Count('channels', filter=Q(channels__epg_data__isnull=False))
        ).all()
        
        stats_data = []
        for group in groups:
            epg_coverage = 0
            if group.channel_count > 0:
                epg_coverage = (group.channels_with_epg / group.channel_count) * 100
            
            # Check for stale channels (simplified - you may have a different stale criteria)
            has_stale = group.channels.filter(
                streams__is_stale=True
            ).exists() if hasattr(group, 'channels') else False
            
            stats_data.append({
                'id': group.id,
                'name': group.name,
                'channel_count': group.channel_count,
                'epg_coverage_percent': round(epg_coverage, 2),
                'has_stale_channels': has_stale
            })
        
        return Response({'groups': stats_data})

    @extend_schema(
        methods=["POST"],
        description="Delete all channel groups that have no associations (no channels or M3U accounts)",
    )
    @action(detail=False, methods=["post"], url_path="cleanup")
    def cleanup_unused_groups(self, request):
        """Delete all channel groups with no channels or M3U account associations"""
        from django.db.models import Q, Exists, OuterRef

        # Find groups with no channels and no M3U account associations using Exists subqueries
        from .models import Channel, ChannelGroupM3UAccount

        has_channels = Channel.objects.filter(channel_group_id=OuterRef('pk'))
        has_accounts = ChannelGroupM3UAccount.objects.filter(channel_group_id=OuterRef('pk'))

        unused_groups = ChannelGroup.objects.annotate(
            has_channels=Exists(has_channels),
            has_accounts=Exists(has_accounts)
        ).filter(
            has_channels=False,
            has_accounts=False
        )

        deleted_count = unused_groups.count()
        group_names = list(unused_groups.values_list('name', flat=True))

        # Delete the unused groups
        unused_groups.delete()

        return Response({
            "message": f"Successfully deleted {deleted_count} unused channel groups",
            "deleted_count": deleted_count,
            "deleted_groups": group_names
        })

    def destroy(self, request, *args, **kwargs):
        """Override destroy to delete associated channels and profile groups before deleting the group"""
        instance = self.get_object()

        try:
            with transaction.atomic():
                # Delete ProfileGroup associations first (many-to-many through table)
                profile_group_count = instance.profile_groups.count()
                if profile_group_count > 0:
                    logger.info(f"Deleting {profile_group_count} profile group associations for group {instance.name}")
                    instance.profile_groups.all().delete()
                
                # Delete associated channels
                channel_count = instance.channels.count()
                if channel_count > 0:
                    logger.info(f"Deleting {channel_count} channels associated with group {instance.name}")
                    # Explicitly delete each channel to ensure all related objects are cleaned up
                    for channel in instance.channels.all():
                        channel.delete()

                # Now delete the group itself
                instance.delete()
                
                return Response(status=status.HTTP_204_NO_CONTENT)
        except Exception as e:
            logger.error(f"Error deleting channel group {instance.name}: {str(e)}")
            return Response(
                {"error": f"Failed to delete group: {str(e)}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @action(detail=True, methods=['post'], url_path='reorder-channels')
    def reorder_channels(self, request, pk=None):
        """Set the manual sort_order for channels in this group.
        Expects: { "channel_ids": [id1, id2, id3, ...] }
        The order of IDs in the list determines their sort_order (0, 1, 2, ...).
        Also sets the group's sort_mode to 'manual'.
        """
        group = self.get_object()
        channel_ids = request.data.get('channel_ids', [])

        if not isinstance(channel_ids, list):
            return Response(
                {'error': 'channel_ids must be a list of channel IDs'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            # Set group to manual sort mode
            if group.sort_mode != 'manual':
                group.sort_mode = 'manual'
                group.save(update_fields=['sort_mode'])

            # Bulk-update sort_order for each channel
            channels_to_update = []
            for order, channel_id in enumerate(channel_ids):
                channels_to_update.append(
                    Channel(id=channel_id, sort_order=order)
                )

            if channels_to_update:
                Channel.objects.bulk_update(channels_to_update, ['sort_order'], batch_size=500)

        return Response({
            'message': f'Updated sort order for {len(channel_ids)} channels',
            'sort_mode': 'manual',
        })


# ─────────────────────────────────────────────────────────
# 3) Channel Management (CRUD)
# ─────────────────────────────────────────────────────────
class ChannelPagination(PageNumberPagination):
    page_size = 50  # Default page size to match frontend default
    page_size_query_param = "page_size"  # Allow clients to specify page size
    max_page_size = 1000  # Prevent excessive page sizes that cause timeouts

    def paginate_queryset(self, queryset, request, view=None):
        if not request.query_params.get(self.page_query_param):
            return None  # disables pagination, returns full queryset

        return super().paginate_queryset(queryset, request, view)


class EPGFilter(django_filters.Filter):
    """
    Filter channels by EPG source name or null (unlinked).
    """
    def filter(self, queryset, value):
        if not value:
            return queryset

        # Split comma-separated values
        values = [v.strip() for v in value.split(',')]
        query = Q()

        for val in values:
            if val == 'null':
                # Filter for channels with no EPG data
                query |= Q(epg_data__isnull=True)
            else:
                # Filter for channels with specific EPG source name
                query |= Q(epg_data__epg_source__name__icontains=val)

        return queryset.filter(query)


class ChannelFilter(django_filters.FilterSet):
    name = django_filters.CharFilter(lookup_expr="icontains")
    channel_group = OrInFilter(
        field_name="channel_group__name", lookup_expr="icontains"
    )
    epg = EPGFilter()

    class Meta:
        model = Channel
        fields = [
            "name",
            "channel_group",
            "epg",
        ]


class ChannelViewSet(viewsets.ModelViewSet):
    queryset = Channel.objects.all()
    serializer_class = ChannelSerializer
    pagination_class = ChannelPagination

    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class = ChannelFilter
    search_fields = ["name", "channel_group__name"]
    ordering_fields = ["channel_number", "name", "channel_group__name"]
    ordering = ["-channel_number"]

    def _handle_channel_profile_memberships(self, channel, profile_ids=None):
        """
        Helper to assign a channel to profiles based on semantics:
        - Omitted (None): add to ALL profiles (backward compatible default)
        - Empty array []: add to NO profiles
        - Sentinel [0] or 0: add to ALL profiles (explicit)
        - [1,2,...]: add to specified profile IDs only
        """
        if profile_ids is not None:
            # Normalize single value to list
            if not isinstance(profile_ids, list):
                profile_ids = [profile_ids]
            
            # Normalize all IDs to integers for consistent comparison
            # Support both integer 0 and string '0' as sentinel
            normalized_ids = []
            for pid in profile_ids:
                try:
                    normalized_ids.append(int(pid))
                except (ValueError, TypeError):
                    pass
            profile_ids = normalized_ids

        # Determine action
        if profile_ids is None or 0 in profile_ids:
            # Add to all profiles
            profiles = ChannelProfile.objects.all()
            ChannelProfileMembership.objects.bulk_create([
                ChannelProfileMembership(channel_profile=profile, channel=channel, enabled=True)
                for profile in profiles
            ])
        elif len(profile_ids) == 0:
            # Add to no profiles
            pass
        else:
            # Specific profile IDs
            channel_profiles = ChannelProfile.objects.filter(id__in=profile_ids)
            if len(channel_profiles) != len(profile_ids):
                found_ids = set(channel_profiles.values_list('id', flat=True))
                missing_ids = set(profile_ids) - found_ids
                raise serializers.ValidationError(
                    {"error": f"Channel profiles with IDs {list(missing_ids)} not found"}
                )

            ChannelProfileMembership.objects.bulk_create([
                ChannelProfileMembership(channel_profile=profile, channel=channel, enabled=True)
                for profile in channel_profiles
            ])

    def create(self, request, *args, **kwargs):
        """Override create to handle channel profile membership"""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        with transaction.atomic():
            channel = serializer.save()
            self._handle_channel_profile_memberships(
                channel, 
                request.data.get("channel_profile_ids")
            )

        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    def get_permissions(self):
        if self.action in [
            "edit_bulk",
            "assign",
            "from_stream",
            "from_stream_bulk",
            "match_epg",
            "set_epg",
            "batch_set_epg",
            "create_empty",
        ]:
            return [IsAdmin()]

        try:
            return [perm() for perm in permission_classes_by_action[self.action]]
        except KeyError:
            return [Authenticated()]

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related(
                "channel_group",
                "logo",
                "epg_data",
                "stream_profile",
            )
            .prefetch_related("streams")
        )

        channel_group = self.request.query_params.get("channel_group")
        group_obj = None
        if channel_group:
            group_names = channel_group.split(",")
            qs = qs.filter(channel_group__name__in=group_names)
            # If filtering by a single group, apply group-level sort settings
            if len(group_names) == 1:
                try:
                    group_obj = ChannelGroup.objects.get(name=group_names[0])
                except ChannelGroup.DoesNotExist:
                    pass

        filters = {}
        q_filters = Q()

        channel_profile_id = self.request.query_params.get("channel_profile_id")
        show_disabled_param = self.request.query_params.get("show_disabled", None)
        only_streamless = self.request.query_params.get("only_streamless", None)

        if channel_profile_id:
            try:
                profile_id_int = int(channel_profile_id)

                if show_disabled_param is None:
                    # Show only enabled channels: channels that have a membership
                    # record for this profile with enabled=True
                    # Default is DISABLED (channels without membership are hidden)
                    filters["channelprofilemembership__channel_profile_id"] = profile_id_int
                    filters["channelprofilemembership__enabled"] = True
                # If show_disabled is True, show all channels (no filtering needed)

            except (ValueError, TypeError):
                # Ignore invalid profile id values
                pass

        if only_streamless:
            q_filters &= Q(streams__isnull=True)

        only_with_streams = self.request.query_params.get("only_with_streams", None)
        if only_with_streams:
            q_filters &= Q(streams__isnull=False)

        stream_source = self.request.query_params.get("stream_source", None)
        if stream_source:
            try:
                if stream_source.startswith("m3u-"):
                    m3u_id = int(stream_source.replace("m3u-", ""))
                    q_filters &= Q(streams__m3u_account_id=m3u_id)
                elif stream_source.startswith("xtream-"):
                    xtream_id = int(stream_source.replace("xtream-", ""))
                    q_filters &= Q(streams__xtream_account_id=xtream_id)
            except (ValueError, TypeError):
                pass

        has_epg = self.request.query_params.get("has_epg", None)
        if has_epg is not None:
            if str(has_epg).lower() in ("1", "true", "yes", "on"):
                q_filters &= Q(epg_data__isnull=False)
            else:
                q_filters &= Q(epg_data__isnull=True)

        is_hidden = self.request.query_params.get("is_hidden", None)
        if is_hidden is not None and is_hidden != "":
            if str(is_hidden).lower() in ("1", "true", "yes", "on"):
                q_filters &= Q(is_hidden=True)
            else:
                q_filters &= Q(is_hidden=False)

        if self.request.user.user_level < 10:
            filters["user_level__lte"] = self.request.user.user_level
            # Hide adult content if user preference is set
            custom_props = self.request.user.custom_properties or {}
            if custom_props.get('hide_adult_content', False):
                filters["is_adult"] = False

        if filters:
            qs = qs.filter(**filters)
        if q_filters:
            qs = qs.filter(q_filters)

        qs = qs.distinct()

        # Store the resolved group object so filter_queryset() can apply
        # group-level ordering AFTER DRF's OrderingFilter has run.
        self._resolved_group = group_obj

        return qs

    def filter_queryset(self, queryset):
        """Override to apply group-level ordering after all filter backends
        (including OrderingFilter) have run, so it isn't overridden by the
        viewset's default ``ordering = ['-channel_number']``.
        """
        queryset = super().filter_queryset(queryset)

        group_obj = getattr(self, '_resolved_group', None)
        if group_obj and not self.request.query_params.get("ordering"):
            ordering = self._get_group_ordering(group_obj)
            queryset = queryset.order_by(*ordering)

        return queryset

    @staticmethod
    def _get_group_ordering(group):
        """Resolve a ChannelGroup's sort_mode/sort_field into Django ORM ordering."""
        if group.sort_mode == 'manual':
            return ['sort_order', 'channel_number']

        sort_field_map = {
            'channel_number_asc': ['channel_number'],
            'channel_number_desc': ['-channel_number'],
            'name_asc': ['name'],
            'name_desc': ['-name'],
        }
        return sort_field_map.get(group.sort_field, ['channel_number'])

    def get_serializer_context(self):
        context = super().get_serializer_context()
        include_streams = (
            self.request.query_params.get("include_streams", "false") == "true"
        )
        context["include_streams"] = include_streams
        return context



    @action(detail=False, methods=["patch"], url_path="edit/bulk")
    def edit_bulk(self, request):
        """
        Bulk edit channels efficiently.
        Validates all updates first, then applies in a single transaction.
        """
        data = request.data
        if not isinstance(data, list):
            return Response(
                {"error": "Expected a list of channel updates"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Extract IDs and validate presence
        channel_updates = {}
        missing_ids = []

        for i, channel_data in enumerate(data):
            channel_id = channel_data.get("id")
            if not channel_id:
                missing_ids.append(f"Item {i}: Channel ID is required")
            else:
                try:
                    # Coerce ID to int to match database dict keys
                    channel_id_int = int(channel_id)
                    channel_updates[channel_id_int] = channel_data
                except (ValueError, TypeError):
                    missing_ids.append(f"Item {i}: Invalid Channel ID format")

        if missing_ids:
            return Response(
                {"errors": missing_ids},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Fetch all channels at once (one query)
        channels_dict = {
            c.id: c for c in Channel.objects.filter(id__in=channel_updates.keys())
        }

        # Validate and prepare updates
        validated_updates = []
        errors = []

        for channel_id, channel_data in channel_updates.items():
            channel = channels_dict.get(channel_id)

            if not channel:
                errors.append({
                    "channel_id": channel_id,
                    "error": "Channel not found"
                })
                continue

            # Handle channel_group_id conversion
            if 'channel_group_id' in channel_data:
                group_id = channel_data['channel_group_id']
                if group_id is not None:
                    try:
                        channel_data['channel_group_id'] = int(group_id)
                    except (ValueError, TypeError):
                        channel_data['channel_group_id'] = None

            # Validate with serializer
            serializer = ChannelSerializer(
                channel, data=channel_data, partial=True
            )

            if serializer.is_valid():
                validated_updates.append((channel, serializer.validated_data))
            else:
                errors.append({
                    "channel_id": channel_id,
                    "errors": serializer.errors
                })

        if errors:
            return Response(
                {"errors": errors, "updated_count": len(validated_updates)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Apply all updates in a transaction
        with transaction.atomic():
            for channel, validated_data in validated_updates:
                # Remove streams from bulk attribute setting since it's an M2M field
                # that requires special handling (and bulk_update doesn't support M2M)
                attrs_to_set = validated_data.copy()
                attrs_to_set.pop('streams', None)
                
                for key, value in attrs_to_set.items():
                    setattr(channel, key, value)

            # Single bulk_update query instead of individual saves
            channels_to_update = [channel for channel, _ in validated_updates]
            if channels_to_update:
                # Collect all unique field names from all updates
                all_fields = set()
                for _, validated_data in validated_updates:
                    all_fields.update(validated_data.keys())

                # Only call bulk_update if there are fields to update
                if all_fields:
                    # Filter out M2M fields for bulk_update
                    update_fields = [f for f in all_fields if f != 'streams']
                    if update_fields:
                        Channel.objects.bulk_update(
                            channels_to_update,
                            fields=update_fields,
                            batch_size=100
                        )

        # Return the updated objects (already in memory)
        serialized_channels = ChannelSerializer(
            [channel for channel, _ in validated_updates],
            many=True,
            context=self.get_serializer_context()
        ).data

        return Response({
            "message": f"Successfully updated {len(validated_updates)} channels",
            "channels": serialized_channels
        })

    @action(detail=False, methods=["post"], url_path="set-names-from-epg")
    def set_names_from_epg(self, request):
        """
        Trigger a Celery task to set channel names from EPG data
        """
        from .tasks import set_channels_names_from_epg

        data = request.data
        channel_ids = data.get("channel_ids", [])

        if not channel_ids:
            return Response(
                {"error": "channel_ids is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not isinstance(channel_ids, list):
            return Response(
                {"error": "channel_ids must be a list"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Start the Celery task
        task = set_channels_names_from_epg.delay(channel_ids)

        return Response({
            "message": f"Started EPG name setting task for {len(channel_ids)} channels",
            "task_id": task.id,
            "channel_count": len(channel_ids)
        })

    @action(detail=False, methods=["post"], url_path="set-logos-from-epg")
    def set_logos_from_epg(self, request):
        """
        Trigger a Celery task to set channel logos from EPG data
        """
        from .tasks import set_channels_logos_from_epg

        data = request.data
        channel_ids = data.get("channel_ids", [])

        if not channel_ids:
            return Response(
                {"error": "channel_ids is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not isinstance(channel_ids, list):
            return Response(
                {"error": "channel_ids must be a list"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Start the Celery task
        task = set_channels_logos_from_epg.delay(channel_ids)

        return Response({
            "message": f"Started EPG logo setting task for {len(channel_ids)} channels",
            "task_id": task.id,
            "channel_count": len(channel_ids)
        })

    @action(detail=False, methods=["post"], url_path="set-tvg-ids-from-epg")
    def set_tvg_ids_from_epg(self, request):
        """
        Trigger a Celery task to set channel TVG-IDs from EPG data
        """
        from .tasks import set_channels_tvg_ids_from_epg

        data = request.data
        channel_ids = data.get("channel_ids", [])

        if not channel_ids:
            return Response(
                {"error": "channel_ids is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not isinstance(channel_ids, list):
            return Response(
                {"error": "channel_ids must be a list"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Start the Celery task
        task = set_channels_tvg_ids_from_epg.delay(channel_ids)

        return Response({
            "message": f"Started EPG TVG-ID setting task for {len(channel_ids)} channels",
            "task_id": task.id,
            "channel_count": len(channel_ids)
        })

    @action(detail=False, methods=["get"], url_path="ids")
    def get_ids(self, request, *args, **kwargs):
        # Get the filtered queryset
        queryset = self.get_queryset()

        # Apply filtering, search, and ordering
        queryset = self.filter_queryset(queryset)

        # Return only the IDs from the queryset
        channel_ids = queryset.values_list("id", flat=True)

        # Return the response with the list of IDs
        return Response(list(channel_ids))

    @extend_schema(
        methods=["POST"],
        description="Auto-assign channel_number in bulk by an ordered list of channel IDs.",
        request=inline_serializer(
            name="AssignChannelsRequest",
            fields={
                "starting_number": serializers.FloatField(
                    help_text="Starting channel number to assign (can be decimal)",
                    required=False,
                ),
                "channel_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="Channel IDs to assign",
                ),
            },
        ),
    )
    @action(detail=False, methods=["post"], url_path="assign")
    def assign(self, request):
        with transaction.atomic():
            channel_ids = request.data.get("channel_ids", [])
            # Ensure starting_number is processed as a float
            try:
                channel_num = float(request.data.get("starting_number", 1))
            except (ValueError, TypeError):
                channel_num = 1.0

            for channel_id in channel_ids:
                Channel.objects.filter(id=channel_id).update(channel_number=channel_num)
                channel_num = channel_num + 1

        return Response(
            {"message": "Channels have been auto-assigned!"}, status=status.HTTP_200_OK
        )

    @extend_schema(
        methods=["POST"],
        description="Create a new channel from a stream ID.",
        request=inline_serializer(
            name="FromStreamRequest",
            fields={
                "stream_id": serializers.IntegerField(help_text="ID of the stream to link"),
                "channel_group_id": serializers.IntegerField(help_text="ID of the group to place the channel in", required=False),
                "channel_number": serializers.FloatField(
                    help_text="(Optional) Desired channel number. Must not be in use.",
                    required=False,
                ),
                "name": serializers.CharField(help_text="Desired channel name", required=False),
                "channel_profile_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="(Optional) Channel profile ID(s). Behavior: omitted = add to ALL profiles (default); empty array [] = add to NO profiles; [0] = add to ALL profiles (explicit); [1,2,...] = add only to specified profiles.",
                    required=False,
                ),
            },
        ),
        responses={201: ChannelSerializer()},
    )
    @action(detail=False, methods=["post"], url_path="from-stream")
    def from_stream(self, request):
        try:
            stream_id = request.data.get("stream_id")
            if not stream_id:
                return Response(
                    {"error": "Missing stream_id"}, status=status.HTTP_400_BAD_REQUEST
                )
            
            stream = get_object_or_404(Stream, pk=stream_id)

            # Use provided channel_group_id if given, otherwise fall back to stream's group
            provided_group_id = request.data.get("channel_group_id")
            channel_group = None
            if provided_group_id:
                channel_group = get_object_or_404(ChannelGroup, pk=provided_group_id)
            else:
                channel_group = stream.channel_group

            # Determine name with fallbacks
            name = request.data.get("name")
            if name is None or name == "":
                name = stream.name or stream.tvg_id or f"Stream {stream.id}"

            # Check if client provided a channel_number; if not, use stream_chno or auto-assign
            channel_number = request.data.get("channel_number")

            if channel_number is None:
                # Channel number not provided by client, check stream's channel number or auto-assign
                if stream.stream_chno is not None:
                    channel_number = stream.stream_chno
            elif channel_number == 0:
                # Special case: 0 means ignore provider numbers and auto-assign
                channel_number = None

            if channel_number is None:
                # Still None, auto-assign the next available channel number
                channel_number = Channel.get_next_available_channel_number()

            try:
                channel_number = float(channel_number)
            except (ValueError, TypeError):
                return Response(
                    {"error": "channel_number must be a valid number."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
                
            # If the provided number is already used, find next available
            if Channel.objects.filter(channel_number=channel_number).exists():
                channel_number = Channel.get_next_available_channel_number(channel_number)
                
            # Get the tvc_guide_stationid from custom properties if it exists
            stream_custom_props = stream.custom_properties or {}
            tvc_guide_stationid = stream_custom_props.get("tvc-guide-stationid")

            channel_data = {
                "channel_number": channel_number,
                "name": name,
                "tvg_id": stream.tvg_id,
                "tvc_guide_stationid": tvc_guide_stationid,
                "streams": [stream_id],
                "is_adult": stream.is_adult or False,
                "is_hidden": False,
                "sort_order": 0,
                "auto_created": False,
            }

            # Only add channel_group_id if a group was found
            if channel_group:
                channel_data["channel_group_id"] = channel_group.id

            if stream.logo_url:
                # Import validation function
                from apps.channels.tasks import validate_logo_url
                validated_logo_url = validate_logo_url(stream.logo_url)
                if validated_logo_url:
                    try:
                        logo, _ = Logo.objects.get_or_create(
                            url=validated_logo_url, 
                            defaults={"name": stream.name or stream.tvg_id or "Logo"}
                        )
                        channel_data["logo_id"] = logo.id
                    except Exception as e:
                        logger.warning(f"Failed to create/get Logo for stream {stream_id}: {e}")

            # Attempt to find existing EPGs with the same tvg-id
            if stream.tvg_id:
                from apps.epg.models import EPGData
                epgs = EPGData.objects.filter(tvg_id=stream.tvg_id)
                if epgs.exists():
                    channel_data["epg_data_id"] = epgs.first().id

            serializer = self.get_serializer(data=channel_data)
            serializer.is_valid(raise_exception=True)

            with transaction.atomic():
                channel = serializer.save()
                self._handle_channel_profile_memberships(
                    channel, 
                    request.data.get("channel_profile_ids")
                )

            # Send WebSocket notification for single channel creation
            try:
                from core.utils import send_websocket_update
                send_websocket_update('updates', 'update', {
                    'type': 'channels_created',
                    'count': 1,
                    'channel_id': channel.id,
                    'channel_name': channel.name,
                    'channel_number': channel.channel_number
                })
            except Exception as ws_err:
                logger.warning(f"Failed to send websocket update for channel creation: {ws_err}")

            return Response(serializer.data, status=status.HTTP_201_CREATED)

        except Exception as e:
            logger.exception(f"Unexpected error in from_stream for stream {request.data.get('stream_id')}: {e}")
            return Response(
                {"error": f"Failed to create channel: {str(e)}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @extend_schema(
        methods=["POST"],
        description=(
            "Asynchronously bulk create channels from stream IDs. "
            "Returns a task ID to track progress via WebSocket. "
            "This is the recommended approach for large bulk operations."
        ),
        request=inline_serializer(
            name="FromStreamBulkRequest",
            fields={
                "stream_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="List of stream IDs to create channels from"
                ),
                "channel_profile_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="(Optional) Channel profile ID(s). Behavior: omitted = add to ALL profiles (default); empty array [] = add to NO profiles; [0] = add to ALL profiles (explicit); [1,2,...] = add only to specified profiles.",
                    required=False,
                ),
                "starting_channel_number": serializers.IntegerField(
                    help_text="(Optional) Starting channel number mode: null=use provider numbers, 0=lowest available, other=start from specified number",
                    required=False,
                ),
            },
        ),
    )
    @action(detail=False, methods=["post"], url_path="from-stream/bulk")
    def from_stream_bulk(self, request):
        from .tasks import bulk_create_channels_from_streams

        stream_ids = request.data.get("stream_ids", [])
        channel_profile_ids = request.data.get("channel_profile_ids")
        starting_channel_number = request.data.get("starting_channel_number")
        channel_group_id = request.data.get("channel_group_id")

        if not stream_ids:
            return Response(
                {"error": "stream_ids is required and cannot be empty"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not isinstance(stream_ids, list):
            return Response(
                {"error": "stream_ids must be a list of integers"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Normalize channel_profile_ids to array if single ID provided
        if channel_profile_ids is not None:
            if not isinstance(channel_profile_ids, list):
                channel_profile_ids = [channel_profile_ids]

        # Start the async task
        task = bulk_create_channels_from_streams.delay(
            stream_ids, channel_profile_ids, starting_channel_number, channel_group_id
        )

        return Response({
            "task_id": task.id,
            "message": f"Bulk channel creation task started for {len(stream_ids)} streams",
            "stream_count": len(stream_ids),
            "status": "started"
        }, status=status.HTTP_202_ACCEPTED)

    # ─────────────────────────────────────────────────────────
    # 6) EPG Fuzzy Matching
    # ─────────────────────────────────────────────────────────
    @extend_schema(
        methods=["POST"],
        description="Kick off a Celery task that tries to fuzzy-match channels with EPG data. If channel_ids are provided, only those channels will be processed.",
        request=inline_serializer(
            name="MatchEpgRequest",
            fields={
                'channel_ids': serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text='List of channel IDs to process. If empty or not provided, all channels without EPG will be processed.',
                    required=False,
                )
            }
        ),
    )
    @action(detail=False, methods=["post"], url_path="match-epg")
    def match_epg(self, request):
        # Get channel IDs from request body if provided
        channel_ids = request.data.get('channel_ids', [])
        channel_group_id = request.data.get('channel_group', None)
        profile_id = request.data.get('profile_id', None)

        # If a group is specified, resolve to channel IDs
        if channel_group_id and not channel_ids:
            channel_ids = list(
                Channel.objects.filter(channel_group_id=channel_group_id)
                .values_list('id', flat=True)
            )

        # If a profile is specified, resolve to all channel IDs in that profile's groups
        if profile_id and not channel_ids:
            from apps.channels.models import ProfileGroup
            group_ids = ProfileGroup.objects.filter(
                profile_id=profile_id
            ).values_list('group_id', flat=True)
            channel_ids = list(
                Channel.objects.filter(channel_group_id__in=group_ids)
                .values_list('id', flat=True)
            )

        if channel_ids:
            # Process only selected channels
            from .tasks import match_selected_channels_epg
            match_selected_channels_epg.delay(channel_ids)
            message = f"EPG matching task initiated for {len(channel_ids)} selected channel(s)."
        else:
            # Process all channels without EPG (original behavior)
            match_epg_channels.delay()
            message = "EPG matching task initiated for all channels without EPG."

        return Response(
            {"message": message}, status=status.HTTP_202_ACCEPTED
        )

    @extend_schema(
        methods=["DELETE"],
        description="Bulk delete channels from a list of IDs.",
        request=inline_serializer(
            name="BulkDeleteChannelsRequest",
            fields={
                "channel_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="Channel IDs to delete",
                )
            },
        ),
    )
    @action(detail=False, methods=["delete"], url_path="bulk-delete")
    def bulk_delete(self, request):
        channel_ids = request.data.get("channel_ids", [])
        if not channel_ids:
            return Response({"error": "No channel_ids provided"}, status=400)
        
        from .models import Channel
        count, _ = Channel.objects.filter(id__in=channel_ids).delete()
        return Response({"message": f"Deleted {count} channels", "deleted_count": count}, status=status.HTTP_200_OK)

    @extend_schema(
        methods=["POST"],
        description="Deduplicate channels from a list of IDs by keeping only one per name.",
        request=inline_serializer(
            name="BulkDedupeChannelsRequest",
            fields={
                "channel_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="Channel IDs to deduplicate",
                )
            },
        ),
    )
    @action(detail=False, methods=["post"], url_path="bulk-dedupe")
    def bulk_dedupe(self, request):
        channel_ids = request.data.get("channel_ids", [])
        if not channel_ids:
            return Response({"error": "No channel_ids provided"}, status=400)

        from .models import Channel
        channels = Channel.objects.filter(id__in=channel_ids).only('id', 'name', 'channel_group_id').order_by('id')
        seen = set()
        to_delete = []

        for c in channels:
            key = (c.name.lower().strip(), c.channel_group_id)
            if key in seen:
                to_delete.append(c.id)
            else:
                seen.add(key)

        if to_delete:
            count, _ = Channel.objects.filter(id__in=to_delete).delete()
            return Response({"message": f"Removed {count} duplicate channels", "deleted_count": count})
        
        return Response({"message": "No duplicates found", "deleted_count": 0})

    @extend_schema(
        methods=["POST"],
        description="Try to auto-match this specific channel with EPG data.",
    )
    @action(detail=True, methods=["post"], url_path="match-epg")
    def match_channel_epg(self, request, pk=None):
        channel = self.get_object()

        # Import the matching logic
        from apps.channels.tasks import match_single_channel_epg

        try:
            # Try to match this specific channel - call synchronously for immediate response
            result = match_single_channel_epg.apply_async(args=[channel.id]).get(timeout=30)

            # Refresh the channel from DB to get any updates
            channel.refresh_from_db()

            return Response({
                "message": result.get("message", "Channel matching completed"),
                "matched": result.get("matched", False),
                "channel": self.get_serializer(channel).data
            })
        except Exception as e:
            return Response({"error": str(e)}, status=400)

    # ─────────────────────────────────────────────────────────
    # 7) Set EPG and Refresh
    # ─────────────────────────────────────────────────────────
    @extend_schema(
        methods=["POST"],
        description="Set EPG data for a channel and refresh program data",
        request=inline_serializer(
            name="SetEpgRequest",
            fields={
                "epg_data_id": serializers.IntegerField(help_text="EPG data ID to link")
            },
        ),
        responses={200: "EPG data linked and refresh triggered"},
    )
    @action(detail=True, methods=["post"], url_path="set-epg")
    def set_epg(self, request, pk=None):
        channel = self.get_object()
        epg_data_id = request.data.get("epg_data_id")

        # Handle removing EPG link
        if epg_data_id in (None, "", "0", 0):
            channel.epg_data = None
            channel.save(update_fields=["epg_data"])
            return Response(
                {"message": f"EPG data removed from channel {channel.name}"}
            )

        try:
            # Get the EPG data object
            from apps.epg.models import EPGData

            epg_data = EPGData.objects.get(pk=epg_data_id)

            # Set the EPG data and save
            channel.epg_data = epg_data
            channel.save(update_fields=["epg_data"])

            # Only trigger program refresh for non-dummy EPG sources
            status_message = None
            if epg_data.epg_source.source_type != 'dummy':
                # Explicitly trigger program refresh for this EPG
                from apps.epg.tasks import parse_programs_for_tvg_id

                task_result = parse_programs_for_tvg_id.delay(epg_data.id)

                # Prepare response with task status info
                status_message = "EPG refresh queued"
                if task_result.result == "Task already running":
                    status_message = "EPG refresh already in progress"

            # Build response message
            message = f"EPG data set to {epg_data.tvg_id} for channel {channel.name}"
            if status_message:
                message += f". {status_message}"

            return Response(
                {
                    "message": message,
                    "channel": self.get_serializer(channel).data,
                    "task_status": status_message,
                }
            )
        except Exception as e:
            return Response({"error": str(e)}, status=400)

    @extend_schema(
        description=(
            "Reorder a channel by moving it after another channel (or to the start if insert_after_id is null). "
            "The channel will receive the next whole number after the target channel, and all subsequent "
            "channels will be renumbered accordingly."
        ),
        request=inline_serializer(
            name="ReorderChannelRequest",
            fields={
                "insert_after_id": serializers.IntegerField(
                    help_text="ID of the channel to insert after. Use null to move to the beginning.",
                    required=False,
                    allow_null=True,
                ),
            },
        ),
    )
    @action(detail=True, methods=["post"], url_path="reorder")
    def reorder(self, request, pk=None):
        """
        Reorder a channel by moving it after another channel (or to the start if insert_after_id is null).
        Shifts other channels as needed to maintain contiguous ordering.
        """
        channel = self.get_object()
        insert_after_id = request.data.get("insert_after_id")
        old_channel_number = channel.channel_number

        with transaction.atomic():
            if insert_after_id is None:
                # Move to the beginning (channel_number = 1)
                target_number = 0
                desired_number = 1
            else:
                try:
                    target_channel = Channel.objects.get(id=insert_after_id)
                    target_number = target_channel.channel_number or 0
                    desired_number = int(target_number) + 1
                except Channel.DoesNotExist:
                    return Response(
                        {"error": "Target channel not found"},
                        status=status.HTTP_404_NOT_FOUND,
                    )

            if desired_number == old_channel_number:
                # No change needed
                return Response(
                    {
                        "message": f"Channel {channel.name} already at position {desired_number}",
                        "channel": self.get_serializer(channel).data,
                    },
                    status=status.HTTP_200_OK,
                )

            if desired_number < old_channel_number:
                # Moving up: increment all channels between desired_number and old_channel_number-1
                Channel.objects.filter(
                    channel_number__gte=desired_number,
                    channel_number__lt=old_channel_number
                ).update(channel_number=F('channel_number') + 1)
                channel.channel_number = desired_number
                channel.save(update_fields=['channel_number'])
            elif desired_number > old_channel_number:
                # Moving down: shift down channels between old+1 and desired-1, then set to desired-1
                if desired_number > old_channel_number + 1:
                    Channel.objects.filter(
                        channel_number__gt=old_channel_number,
                        channel_number__lt=desired_number
                    ).update(channel_number=F('channel_number') - 1)
                channel.channel_number = desired_number - 1
                channel.save(update_fields=['channel_number'])
            else:
                # No move or same position
                channel.channel_number = desired_number
                channel.save(update_fields=['channel_number'])

        return Response(
            {
                "message": f"Channel {channel.name} moved to position {desired_number}",
                "channel": self.get_serializer(channel).data,
            },
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        methods=["POST"],
        description="Create a new empty channel with no streams attached.",
        request=inline_serializer(
            name="CreateEmptyChannelRequest",
            fields={
                "channel_group_id": serializers.IntegerField(
                    help_text="ID of the channel group to assign the channel to",
                    required=False,
                ),
                "name": serializers.CharField(
                    help_text="Desired channel name", required=False
                ),
                "channel_number": serializers.FloatField(
                    help_text="(Optional) Desired channel number.",
                    required=False,
                ),
            },
        ),
        responses={201: ChannelSerializer()},
    )
    @action(detail=False, methods=["post"], url_path="create-empty")
    def create_empty(self, request):
        channel_group_id = request.data.get("channel_group_id")
        name = request.data.get("name", "New Channel")
        channel_number = request.data.get("channel_number")

        channel_group = None
        if channel_group_id:
            channel_group = get_object_or_404(ChannelGroup, pk=channel_group_id)

        if channel_number is None:
            channel_number = Channel.get_next_available_channel_number()
        else:
            try:
                channel_number = float(channel_number)
            except (ValueError, TypeError):
                return Response(
                    {"error": "channel_number must be a number"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if Channel.objects.filter(channel_number=channel_number).exists():
                channel_number = Channel.get_next_available_channel_number(channel_number)

        with transaction.atomic():
            channel = Channel.objects.create(
                channel_number=channel_number,
                name=name,
                channel_group=channel_group
            )

            # Handle channel profile membership (default to ALL profiles if not specified)
            # This matches the from_stream behavior
            profiles = ChannelProfile.objects.all()
            ChannelProfileMembership.objects.bulk_create([
                ChannelProfileMembership(channel_profile=profile, channel=channel, enabled=True)
                for profile in profiles
            ])

        serializer = self.get_serializer(channel)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


    @extend_schema(
        methods=["POST"],
        description="Associate multiple channels with EPG data without triggering a full refresh",
        request=inline_serializer(
            name="BatchSetEpgRequest",
            fields={
                "associations": serializers.ListField(
                    child=inline_serializer(
                        name="EpgAssociation",
                        fields={
                            "channel_id": serializers.IntegerField(),
                            "epg_data_id": serializers.IntegerField(),
                        },
                    ),
                )
            },
        ),
    )
    @action(detail=False, methods=["post"], url_path="batch-set-epg")
    def batch_set_epg(self, request):
        """Efficiently associate multiple channels with EPG data at once."""
        associations = request.data.get("associations", [])

        if not associations:
            return Response(
                {"error": "associations list is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Extract channel IDs upfront
        channel_updates = {}
        unique_epg_ids = set()

        for assoc in associations:
            channel_id = assoc.get("channel_id")
            epg_data_id = assoc.get("epg_data_id")

            if not channel_id:
                continue

            channel_updates[channel_id] = epg_data_id
            if epg_data_id:
                unique_epg_ids.add(epg_data_id)

        # Batch fetch all channels (single query)
        channels_dict = {
            c.id: c for c in Channel.objects.filter(id__in=channel_updates.keys())
        }

        # Collect channels to update
        channels_to_update = []
        for channel_id, epg_data_id in channel_updates.items():
            if channel_id not in channels_dict:
                logger.error(f"Channel with ID {channel_id} not found")
                continue

            channel = channels_dict[channel_id]
            channel.epg_data_id = epg_data_id
            channels_to_update.append(channel)

        # Bulk update all channels (single query)
        if channels_to_update:
            with transaction.atomic():
                Channel.objects.bulk_update(
                    channels_to_update,
                    fields=["epg_data_id"],
                    batch_size=100
                )

        channels_updated = len(channels_to_update)

        # Trigger program refresh for unique EPG data IDs (skip dummy EPGs)
        from apps.epg.tasks import parse_programs_for_tvg_id
        from apps.epg.models import EPGData

        # Batch fetch EPG data (single query)
        epg_data_dict = {
            epg.id: epg
            for epg in EPGData.objects.filter(id__in=unique_epg_ids).select_related('epg_source')
        }

        programs_refreshed = 0
        for epg_id in unique_epg_ids:
            epg_data = epg_data_dict.get(epg_id)
            if not epg_data:
                logger.error(f"EPGData with ID {epg_id} not found")
                continue

            # Only refresh non-dummy EPG sources
            if epg_data.epg_source.source_type != 'dummy':
                parse_programs_for_tvg_id.delay(epg_id)
                programs_refreshed += 1

        return Response(
            {
                "success": True,
                "channels_updated": channels_updated,
                "programs_refreshed": programs_refreshed,
            }
        )

    @extend_schema(
        methods=["POST"],
        description="Remap channel streams from one source to another using tvg_id and channel name matching.",
        request=inline_serializer(
            name="RemapChannelsRequest",
            fields={
                "source_type": serializers.ChoiceField(
                    choices=["m3u", "xtream"],
                    help_text="Type of source account",
                ),
                "source_id": serializers.IntegerField(
                    help_text="ID of the source account",
                ),
                "dest_type": serializers.ChoiceField(
                    choices=["m3u", "xtream"],
                    help_text="Type of destination account",
                ),
                "dest_id": serializers.IntegerField(
                    help_text="ID of the destination account",
                ),
                "channel_group_id": serializers.IntegerField(
                    help_text="Scope to a single channel group",
                    required=False,
                ),
                "profile_id": serializers.IntegerField(
                    help_text="Scope to all groups in a profile",
                    required=False,
                ),
            },
        ),
    )
    @action(detail=False, methods=["post"], url_path="remap")
    def remap(self, request):
        """
        Remap channel streams from one source to another by matching tvg_id
        or channel name. For each channel in the scope, find streams from the
        source, look up a matching stream (by tvg_id first, then by name) in
        the destination, and swap them.
        """
        source_type = request.data.get("source_type")
        source_id = request.data.get("source_id")
        dest_type = request.data.get("dest_type")
        dest_id = request.data.get("dest_id")
        channel_group_id = request.data.get("channel_group_id")
        profile_id = request.data.get("profile_id")

        if not all([source_type, source_id, dest_type, dest_id]):
            return Response(
                {"error": "source_type, source_id, dest_type, and dest_id are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Build source filter for ChannelStream lookups
        source_stream_filter = {}
        if source_type == "m3u":
            source_stream_filter["stream__m3u_account_id"] = source_id
        else:
            source_stream_filter["stream__xtream_account_id"] = source_id

        # Build destination stream query to create a tvg_id lookup dict
        dest_stream_filter = {}
        if dest_type == "m3u":
            dest_stream_filter["m3u_account_id"] = dest_id
        else:
            dest_stream_filter["xtream_account_id"] = dest_id

        # Build the set of channels to process
        channel_qs = Channel.objects.all()
        if channel_group_id:
            channel_qs = channel_qs.filter(channel_group_id=channel_group_id)
        elif profile_id:
            # Get all group IDs in this profile
            group_ids = ProfileGroup.objects.filter(
                profile_id=profile_id
            ).values_list("channel_group_id", flat=True)
            channel_qs = channel_qs.filter(channel_group_id__in=group_ids)
        else:
            return Response(
                {"error": "Either channel_group_id or profile_id is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        def _normalize_stream_name(name):
            """Normalize a stream name for comparison: strip all punctuation/separators,
            remove '24/7' (common in channel names), collapse whitespace, lowercase."""
            if not name:
                return ""
            import re as _re
            # Remove 24/7 before stripping punctuation (so the / doesn't leave artifacts)
            norm = _re.sub(r'24\s*/\s*7', ' ', name)
            # Remove all non-alphanumeric characters (|, :, -, etc.), collapse whitespace, lowercase
            norm = _re.sub(r"[^a-zA-Z0-9\s]", " ", norm)
            norm = _re.sub(r"\s+", " ", norm).strip().lower()
            return norm

        def _normalize_tvg_id(tvg_id):
            """Strip trailing digits from tvg_id for fuzzy matching.
            e.g. 'TheWeatherChannel.us1' -> 'TheWeatherChannel.us'
            Xtream providers often append instance numbers to tvg_ids.
            """
            if not tvg_id:
                return ""
            import re as _re
            return _re.sub(r'\d+$', '', tvg_id)

        # Pre-build lookups for destination streams
        # Primary: base tvg_id (trailing digits stripped) -> list of dest streams
        #   This handles both exact matches and provider-appended instance numbers
        #   e.g. TheWeatherChannel.us and TheWeatherChannel.us1 both key as TheWeatherChannel.us
        # Secondary: normalized name -> list of dest streams (for fallback matching)
        #   Names are normalized: punctuation stripped, 24/7 removed, lowercased
        all_dest_streams = Stream.objects.filter(
            **dest_stream_filter
        ).only("id", "tvg_id", "channel_group_id", "name")

        dest_by_tvg_id = {}
        dest_by_name = {}
        for s in all_dest_streams:
            if s.tvg_id:
                base = _normalize_tvg_id(s.tvg_id)
                if base:
                    dest_by_tvg_id.setdefault(base, []).append(s)
            if s.name:
                norm_name = _normalize_stream_name(s.name)
                if norm_name:
                    dest_by_name.setdefault(norm_name, []).append(s)

        remapped_count = 0
        errors = []

        channel_ids = list(channel_qs.values_list("id", flat=True))

        # Process in batches to avoid loading everything at once
        with transaction.atomic():
            # Get all ChannelStream entries for these channels from the source
            cs_entries = ChannelStream.objects.filter(
                channel_id__in=channel_ids,
                **source_stream_filter,
            ).select_related("stream", "channel")

            for cs in cs_entries:
                source_stream = cs.stream
                tvg_id = source_stream.tvg_id
                source_name = _normalize_stream_name(source_stream.name)

                # Step 1: tvg_id match (normalized — strips trailing digits)
                matched_by = "tvg_id"
                base_tvg = _normalize_tvg_id(tvg_id) if tvg_id else ""
                candidates = dest_by_tvg_id.get(base_tvg, []) if base_tvg else []

                # Step 2: Fall back to name match
                if not candidates and source_name:
                    candidates = dest_by_name.get(source_name, [])
                    matched_by = "name"

                if not candidates:
                    errors.append({
                        "channel_name": cs.channel.name,
                        "channel_id": cs.channel.id,
                        "tvg_id": tvg_id,
                        "reason": "No matching stream found in destination (tried tvg_id and name)",
                    })
                    continue

                if matched_by == "tvg_id":
                    # tvg_id match: pick the best single candidate (prefer same group)
                    dest_stream = None
                    for c in candidates:
                        if c.channel_group_id == cs.channel.channel_group_id:
                            dest_stream = c
                            break
                    if not dest_stream:
                        dest_stream = candidates[0]

                    # Check if already using this dest stream (skip if same)
                    if cs.stream_id == dest_stream.id:
                        continue

                    # Check if a ChannelStream already exists for this channel+dest_stream
                    existing = ChannelStream.objects.filter(
                        channel=cs.channel, stream=dest_stream
                    ).exists()

                    if existing:
                        # Just remove the old source entry
                        cs.delete()
                    else:
                        # Swap: update the stream reference in-place to preserve order
                        cs.stream = dest_stream
                        cs.save(update_fields=["stream_id"])

                    remapped_count += 1
                else:
                    # Name match: add ALL matching destination streams to the channel
                    # since name matches may yield multiple valid streams (e.g. HD/SD, 24/7 variants)
                    first = True
                    for dest_stream in candidates:
                        # Skip if this dest stream is already on the channel
                        if ChannelStream.objects.filter(
                            channel=cs.channel, stream=dest_stream
                        ).exists():
                            continue

                        if first:
                            # Swap the existing ChannelStream entry in-place to preserve order
                            if cs.stream_id != dest_stream.id:
                                cs.stream = dest_stream
                                cs.save(update_fields=["stream_id"])
                            first = False
                        else:
                            # Add additional streams after the swapped one
                            ChannelStream.objects.create(
                                channel=cs.channel,
                                stream=dest_stream,
                                order=cs.order + 1 if hasattr(cs, 'order') else 0,
                            )

                    if first:
                        # All candidates were already on the channel, delete the old source entry
                        cs.delete()

                    remapped_count += 1

        return Response({
            "success": True,
            "remapped_count": remapped_count,
            "errors": errors,
        })


# ─────────────────────────────────────────────────────────
# 4) Bulk Delete Streams
# ─────────────────────────────────────────────────────────
class BulkDeleteStreamsAPIView(APIView):
    def get_permissions(self):
        try:
            return [
                perm() for perm in permission_classes_by_method[self.request.method]
            ]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        description="Bulk delete streams by ID",
        request=inline_serializer(
            name="BulkDeleteStreamsRequest",
            fields={
                "stream_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="Stream IDs to delete",
                )
            },
        ),
    )
    def delete(self, request, *args, **kwargs):
        stream_ids = request.data.get("stream_ids", [])
        Stream.objects.filter(id__in=stream_ids).delete()
        return Response(
            {"message": "Streams deleted successfully!"},
            status=status.HTTP_204_NO_CONTENT,
        )


# ─────────────────────────────────────────────────────────
# 6) Bulk Delete Logos
# ─────────────────────────────────────────────────────────
class BulkDeleteLogosAPIView(APIView):
    def get_permissions(self):
        try:
            return [
                perm() for perm in permission_classes_by_method[self.request.method]
            ]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        description="Bulk delete logos by ID",
        request=inline_serializer(
            name="BulkDeleteLogosRequest",
            fields={
                "logo_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="Logo IDs to delete",
                )
            },
        ),
    )
    def delete(self, request):
        logo_ids = request.data.get("logo_ids", [])
        delete_files = request.data.get("delete_files", False)

        # Get logos and their usage info before deletion
        logos_to_delete = Logo.objects.filter(id__in=logo_ids)
        total_channels_affected = 0
        local_files_deleted = 0

        for logo in logos_to_delete:
            # Handle file deletion for local files
            if delete_files and logo.url and logo.url.startswith('/data/logos'):
                try:
                    if os.path.exists(logo.url):
                        os.remove(logo.url)
                        local_files_deleted += 1
                        logger.info(f"Deleted local logo file: {logo.url}")
                except Exception as e:
                    logger.error(f"Failed to delete logo file {logo.url}: {str(e)}")
                    return Response(
                        {"error": f"Failed to delete logo file {logo.url}: {str(e)}"},
                        status=status.HTTP_500_INTERNAL_SERVER_ERROR
                    )

            if logo.channels.exists():
                channel_count = logo.channels.count()
                total_channels_affected += channel_count
                # Remove logo from channels
                logo.channels.update(logo=None)
                logger.info(f"Removed logo {logo.name} from {channel_count} channels before deletion")

        # Delete logos
        deleted_count = logos_to_delete.delete()[0]

        message = f"Successfully deleted {deleted_count} logos"
        if total_channels_affected > 0:
            message += f" and removed them from {total_channels_affected} channels"
        if local_files_deleted > 0:
            message += f" and deleted {local_files_deleted} local files"

        return Response(
            {"message": message},
            status=status.HTTP_204_NO_CONTENT
        )


class CleanupUnusedLogosAPIView(APIView):
    def get_permissions(self):
        try:
            return [
                perm() for perm in permission_classes_by_method[self.request.method]
            ]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        description="Delete all channel logos that are not used by any channels",
        request=inline_serializer(
            name="CleanupUnusedLogosRequest",
            fields={
                "delete_files": serializers.BooleanField(
                    help_text="Whether to delete local logo files from disk",
                    default=False,
                    required=False,
                )
            },
        ),
    )
    def post(self, request):
        """Delete all channel logos with no channel associations"""
        delete_files = request.data.get("delete_files", False)

        # Find logos that are not used by any channels
        unused_logos = Logo.objects.filter(channels__isnull=True)
        deleted_count = unused_logos.count()
        logo_names = list(unused_logos.values_list('name', flat=True))
        local_files_deleted = 0

        # Handle file deletion for local files if requested
        if delete_files:
            for logo in unused_logos:
                if logo.url and logo.url.startswith('/data/logos'):
                    try:
                        if os.path.exists(logo.url):
                            os.remove(logo.url)
                            local_files_deleted += 1
                            logger.info(f"Deleted local logo file: {logo.url}")
                    except Exception as e:
                        logger.error(f"Failed to delete logo file {logo.url}: {str(e)}")
                        return Response(
                            {"error": f"Failed to delete logo file {logo.url}: {str(e)}"},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR
                        )

        # Delete the unused logos
        unused_logos.delete()

        message = f"Successfully deleted {deleted_count} unused logos"
        if local_files_deleted > 0:
            message += f" and deleted {local_files_deleted} local files"

        return Response({
            "message": message,
            "deleted_count": deleted_count,
            "deleted_logos": logo_names,
            "local_files_deleted": local_files_deleted
        })


class LogoPagination(PageNumberPagination):
    page_size = 50  # Default page size to match frontend default
    page_size_query_param = "page_size"  # Allow clients to specify page size
    max_page_size = 1000  # Prevent excessive page sizes

    def paginate_queryset(self, queryset, request, view=None):
        # Check if pagination should be disabled for specific requests
        if request.query_params.get('no_pagination') == 'true':
            return None  # disables pagination, returns full queryset

        return super().paginate_queryset(queryset, request, view)


class LogoViewSet(viewsets.ModelViewSet):
    queryset = Logo.objects.all()
    serializer_class = LogoSerializer
    pagination_class = LogoPagination
    parser_classes = (MultiPartParser, FormParser, JSONParser)

    def get_permissions(self):
        if self.action in ["upload"]:
            return [IsAdmin()]

        if self.action in ["cache"]:
            return [AllowAny()]

        try:
            return [perm() for perm in permission_classes_by_action[self.action]]
        except KeyError:
            return [Authenticated()]

    def get_queryset(self):
        """Optimize queryset with prefetch and add filtering"""
        # Start with basic prefetch for channels
        queryset = Logo.objects.prefetch_related('channels').order_by('name')

        # Filter by specific IDs
        ids = self.request.query_params.getlist('ids')
        if ids:
            try:
                # Convert string IDs to integers and filter
                id_list = [int(id_str) for id_str in ids if id_str.isdigit()]
                if id_list:
                    queryset = queryset.filter(id__in=id_list)
            except (ValueError, TypeError):
                pass  # Invalid IDs, return empty queryset
                queryset = Logo.objects.none()

        # Filter by usage
        used_filter = self.request.query_params.get('used', None)
        if used_filter == 'true':
            # Logo is used if it has any channels
            queryset = queryset.filter(channels__isnull=False).distinct()
        elif used_filter == 'false':
            # Logo is unused if it has no channels
            queryset = queryset.filter(channels__isnull=True)

        # Filter by name
        name_filter = self.request.query_params.get('name', None)
        if name_filter:
            queryset = queryset.filter(name__icontains=name_filter)

        return queryset

    def create(self, request, *args, **kwargs):
        """Create a new logo entry"""
        serializer = self.get_serializer(data=request.data)
        if serializer.is_valid():
            logo = serializer.save()
            return Response(self.get_serializer(logo).data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def update(self, request, *args, **kwargs):
        """Update an existing logo"""
        partial = kwargs.pop('partial', False)
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        if serializer.is_valid():
            logo = serializer.save()
            return Response(self.get_serializer(logo).data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def destroy(self, request, *args, **kwargs):
        """Delete a logo and remove it from any channels using it"""
        logo = self.get_object()
        delete_file = request.query_params.get('delete_file', 'false').lower() == 'true'

        # Check if it's a local file that should be deleted
        if delete_file and logo.url and logo.url.startswith('/data/logos'):
            try:
                if os.path.exists(logo.url):
                    os.remove(logo.url)
                    logger.info(f"Deleted local logo file: {logo.url}")
            except Exception as e:
                logger.error(f"Failed to delete logo file {logo.url}: {str(e)}")
                return Response(
                    {"error": f"Failed to delete logo file: {str(e)}"},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )

        # Instead of preventing deletion, remove the logo from channels
        if logo.channels.exists():
            channel_count = logo.channels.count()
            logo.channels.update(logo=None)
            logger.info(f"Removed logo {logo.name} from {channel_count} channels before deletion")

        return super().destroy(request, *args, **kwargs)

    @action(detail=False, methods=["post"])
    def upload(self, request):
        if "file" not in request.FILES:
            return Response(
                {"error": "No file uploaded"}, status=status.HTTP_400_BAD_REQUEST
            )

        file = request.FILES["file"]

        # Validate file
        try:
            from dispatcharr.utils import validate_logo_file
            validate_logo_file(file)
        except Exception as e:
            return Response(
                {"error": str(e)}, status=status.HTTP_400_BAD_REQUEST
            )

        # Get custom name from request data first, fallback to sanitized filename
        custom_name = request.data.get('name', '').strip()
        
        # Sanitize the filename to prevent URL encoding issues
        # Replace spaces and special characters (except dots for extensions) with underscores
        import re
        import hashlib
        
        if custom_name:
            # Use custom name if provided, sanitize it
            file_name = re.sub(r'[^a-zA-Z0-9.]', '_', custom_name)
        else:
            # Fallback to original filename, but sanitize it
            file_name = re.sub(r'[^a-zA-Z0-9.]', '_', file.name)
        
        # Compute hash of file content for deduplication
        file_hash = hashlib.sha256()
        for chunk in file.chunks():
            file_hash.update(chunk)
        file_hash_hex = file_hash.hexdigest()
        
        # Check if a logo with this hash already exists
        existing_logo = Logo.objects.filter(file_hash=file_hash_hex).first()
        if existing_logo:
            # Reuse existing logo instead of creating a duplicate
            logger.info(f"Reusing existing logo with hash {file_hash_hex}: {existing_logo.url}")
            serializer = self.get_serializer(existing_logo)
            return Response(
                serializer.data,
                status=status.HTTP_200_OK,
            )
        
        # File doesn't exist, save it
        file_path = os.path.join("/data/logos", file_name)

        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        
        # Reset file pointer since we read it for hashing
        file.seek(0)
        
        with open(file_path, "wb+") as destination:
            for chunk in file.chunks():
                destination.write(chunk)

        # Mark file as processed in Redis to prevent file scanner notifications
        try:
            redis_client = RedisClient.get_client()
            if redis_client:
                # Use the same key format as the file scanner
                redis_key = f"processed_file:{file_path}"
                # Store the actual file modification time to match the file scanner's expectation
                file_mtime = os.path.getmtime(file_path)
                redis_client.setex(redis_key, 60 * 60 * 24 * 3, str(file_mtime))  # 3 day TTL
                logger.debug(f"Marked uploaded logo file as processed in Redis: {file_path} (mtime: {file_mtime})")
        except Exception as e:
            logger.warning(f"Failed to mark logo file as processed in Redis: {e}")

        # Get custom name from request data, fallback to filename
        logo_name = custom_name if custom_name else file_name

        logo, _ = Logo.objects.get_or_create(
            url=file_path,
            defaults={
                "name": logo_name,
                "file_hash": file_hash_hex,
            },
        )

        # Use get_serializer to ensure proper context
        serializer = self.get_serializer(logo)
        return Response(
            serializer.data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["get"], permission_classes=[AllowAny])
    def cache(self, request, pk=None):
        """Streams the logo file, whether it's local or remote."""
        logo = self.get_object()
        logo_url = logo.url
        if logo_url.startswith("/data"):  # Local file
            if not os.path.exists(logo_url):
                raise Http404("Image not found")
            stat = os.stat(logo_url)
            # Get proper mime type (first item of the tuple)
            content_type, _ = mimetypes.guess_type(logo_url)
            if not content_type:
                content_type = "image/jpeg"  # Default to a common image type

            # Use context manager and set Content-Disposition to inline
            response = StreamingHttpResponse(
                open(logo_url, "rb"), content_type=content_type
            )
            response["Cache-Control"] = "public, max-age=14400"  # Cache in browser for 4 hours
            response["Last-Modified"] = http_date(stat.st_mtime)
            response["Content-Disposition"] = 'inline; filename="{}"'.format(
                os.path.basename(logo_url)
            )
            return response

        else:  # Remote image
            try:
                # Get the default user agent
                try:
                    default_user_agent_id = CoreSettings.get_default_user_agent_id()
                    user_agent_obj = UserAgent.objects.get(id=int(default_user_agent_id))
                    user_agent = user_agent_obj.user_agent
                except (CoreSettings.DoesNotExist, UserAgent.DoesNotExist, ValueError):
                    # Fallback to hardcoded if default not found
                    user_agent = 'Dispatcharr/1.0'

                # Add proper timeouts to prevent hanging
                remote_response = requests.get(
                    logo_url,
                    stream=True,
                    timeout=(3, 5),  # (connect_timeout, read_timeout)
                    headers={'User-Agent': user_agent}
                )
                if remote_response.status_code == 200:
                    # Try to get content type from response headers first
                    content_type = remote_response.headers.get("Content-Type")

                    # If no content type in headers or it's empty, guess based on URL
                    if not content_type:
                        content_type, _ = mimetypes.guess_type(logo_url)

                    # If still no content type, default to common image type
                    if not content_type:
                        content_type = "image/jpeg"

                    response = StreamingHttpResponse(
                        remote_response.iter_content(chunk_size=8192),
                        content_type=content_type,
                    )
                    if(remote_response.headers.get("Cache-Control")):
                        response["Cache-Control"] = remote_response.headers.get("Cache-Control")
                    if(remote_response.headers.get("Last-Modified")):
                        response["Last-Modified"] = remote_response.headers.get("Last-Modified")
                    response["Content-Disposition"] = 'inline; filename="{}"'.format(
                        os.path.basename(logo_url)
                    )
                    return response
                raise Http404("Remote image not found")
            except requests.exceptions.Timeout:
                logger.warning(f"Timeout fetching logo from {logo_url}")
                raise Http404("Logo request timed out")
            except requests.exceptions.ConnectionError:
                logger.warning(f"Connection error fetching logo from {logo_url}")
                raise Http404("Unable to connect to logo server")
            except requests.RequestException as e:
                logger.warning(f"Error fetching logo from {logo_url}: {e}")
                raise Http404("Error fetching remote image")


class ChannelProfileViewSet(viewsets.ModelViewSet):
    queryset = ChannelProfile.objects.all()
    serializer_class = ChannelProfileSerializer

    def get_queryset(self):
        user = self.request.user
        if user.user_level >= 10:  # Admin
            # Annotate to sort own profiles first
            from django.db.models import Case, When, Value, IntegerField
            return ChannelProfile.objects.annotate(
                is_own=Case(
                    When(created_by=user, then=Value(0)),
                    default=Value(1),
                    output_field=IntegerField()
                )
            ).order_by('is_own', 'name')

        # Standard users see only their own profiles
        return ChannelProfile.objects.filter(created_by=user)

    def get_permissions(self):
        if self.action == "duplicate":
            return [IsAdmin()]
        try:
            return [perm() for perm in permission_classes_by_action[self.action]]
        except KeyError:
            return [Authenticated()]

    def create(self, request, *args, **kwargs):
        """Create a new profile with optional group cloning from M3U sources"""
        print(f"[DEBUG] create() called with data: {request.data}")
        
        user = request.user
        name = request.data.get('name', '').strip()
        clone_groups = request.data.get('clone_groups', [])
        include_channels = request.data.get('include_channels', False)

        print(f"[DEBUG] Parsed - name: '{name}', clone_groups count: {len(clone_groups)}, include_channels: {include_channels}")
        logger.info(f"[CreateProfile] Creating profile '{name}' with {len(clone_groups)} groups, include_channels={include_channels}")
        logger.debug(f"[CreateProfile] clone_groups data: {clone_groups}")

        if not name:
            return Response(
                {'detail': 'Name is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check unique constraint
        if ChannelProfile.objects.filter(created_by=user, name=name).exists():
            return Response(
                {'detail': 'You already have a channel profile with this name.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            # Create the new profile
            new_profile = ChannelProfile.objects.create(
                name=name,
                created_by=user
            )
            logger.info(f"[CreateProfile] Created profile {new_profile.id}: {new_profile.name}")

            # If groups to clone were specified
            if clone_groups:
                groups_added = 0
                channels_added = 0
                
                seen_groups = set()
                for group_data in clone_groups:
                    channel_group_id = group_data.get('channel_group_id')
                    if not channel_group_id or channel_group_id in seen_groups:
                        continue
                    seen_groups.add(channel_group_id)

                    channel_group = ChannelGroup.objects.filter(id=channel_group_id).first()
                    if not channel_group:
                        logger.warning(f"[CreateProfile] Group {channel_group_id} not found")
                        continue

                    # Add the group to the profile
                    max_order = ProfileGroup.objects.filter(profile=new_profile).count()
                    ProfileGroup.objects.create(
                        profile=new_profile,
                        channel_group=channel_group,
                        order=max_order,
                        is_active=True,
                    )
                    groups_added += 1
                    logger.info(f"[CreateProfile] Added group {channel_group.id}: {channel_group.name}")

                    # If include_channels is True, add all channels from this group to the profile
                    if include_channels:
                        channels_in_group = Channel.objects.filter(channel_group=channel_group)
                        channel_count = channels_in_group.count()
                        logger.info(f"[CreateProfile] Found {channel_count} channels in group {channel_group.name}")
                        
                        memberships_to_create = [
                            ChannelProfileMembership(
                                channel_profile=new_profile,
                                channel=channel,
                                enabled=True
                            )
                            for channel in channels_in_group
                        ]
                        if memberships_to_create:
                            created = ChannelProfileMembership.objects.bulk_create(
                                memberships_to_create,
                                ignore_conflicts=True
                            )
                            channels_added += len(created)
                            logger.info(f"[CreateProfile] Created {len(created)} channel memberships")
                
                logger.info(f"[CreateProfile] Summary: Added {groups_added} groups and {channels_added} channels")

            serializer = self.get_serializer(new_profile)
            return Response(serializer.data, status=status.HTTP_201_CREATED)

    @extend_schema(
        request=inline_serializer(
            'CloneProfileRequest',
            fields={
                'name': serializers.CharField(),
                'copy_channels': serializers.BooleanField(default=False)
            }
        ),
        responses={200: ChannelProfileSerializer}
    )
    @action(detail=True, methods=['post'], url_path='clone')
    def clone(self, request, pk=None):
        """Clone a profile with optional channel memberships"""
        user = request.user
        source_profile = self.get_object()
        
        # Check permissions: admins can clone any, users can only clone admin profiles or own
        is_admin = hasattr(user, 'user_level') and user.user_level == 10
        is_admin_profile = source_profile.created_by and source_profile.created_by.user_level == 10
        is_own_profile = source_profile.created_by == user
        
        if not is_admin and not is_admin_profile and not is_own_profile:
            return Response(
                {'error': 'You do not have permission to clone this profile'},
                status=status.HTTP_403_FORBIDDEN
            )
        
        requested_name = str(request.data.get('name', '')).strip()
        copy_channels = request.data.get('copy_channels', False)
        
        if not requested_name:
            return Response(
                {'detail': 'Name is required to clone a profile.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Check unique constraint: unique_together on (created_by, name)
        if ChannelProfile.objects.filter(created_by=user, name=requested_name).exists():
            return Response(
                {'detail': 'You already have a channel profile with this name.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        with transaction.atomic():
            # Create new profile owned by current user
            new_profile = ChannelProfile.objects.create(
                name=requested_name,
                created_by=user
            )
            
            if copy_channels:
                # Copy channel memberships from source profile
                source_memberships = ChannelProfileMembership.objects.filter(
                    channel_profile=source_profile
                )
                
                new_memberships = [
                    ChannelProfileMembership(
                        channel_profile=new_profile,
                        channel=membership.channel,
                        enabled=membership.enabled
                    )
                    for membership in source_memberships
                ]
                
                if new_memberships:
                    ChannelProfileMembership.objects.bulk_create(new_memberships)
            
            serializer = self.get_serializer(new_profile)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
    @action(detail=True, methods=["post"], url_path="duplicate", permission_classes=[IsAdmin])
    def duplicate(self, request, pk=None):
        requested_name = str(request.data.get("name", "")).strip()

        if not requested_name:
            return Response(
                {"detail": "Name is required to duplicate a profile."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if ChannelProfile.objects.filter(name=requested_name).exists():
            return Response(
                {"detail": "A channel profile with this name already exists."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        source_profile = self.get_object()

        with transaction.atomic():
            new_profile = ChannelProfile.objects.create(name=requested_name)

            source_memberships = ChannelProfileMembership.objects.filter(
                channel_profile=source_profile
            )
            source_enabled_map = {
                membership.channel_id: membership.enabled
                for membership in source_memberships
            }

            new_memberships = list(
                ChannelProfileMembership.objects.filter(channel_profile=new_profile)
            )
            for membership in new_memberships:
                membership.enabled = source_enabled_map.get(
                    membership.channel_id, False
                )

            if new_memberships:
                ChannelProfileMembership.objects.bulk_update(
                    new_memberships, ["enabled"]
                )

        serializer = self.get_serializer(new_profile)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'], url_path='groups')
    def groups(self, request, pk=None):
        """List all groups associated with this profile, ordered by their position."""
        profile = self.get_object()
        pgs = ProfileGroup.objects.filter(profile=profile).select_related('channel_group').order_by('order')
        serializer = ProfileGroupSerializer(pgs, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='add-group')
    def add_group(self, request, pk=None):
        """Add a group to this profile. Creates or duplicates the ChannelGroup if specified."""
        profile = self.get_object()
        channel_group_id = request.data.get('channel_group_id')
        group_name = request.data.get('name')
        duplicate_from_id = request.data.get('duplicate_from_id')

        if not channel_group_id and not group_name and not duplicate_from_id:
            return Response(
                {'error': 'Either channel_group_id, name, or duplicate_from_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            if duplicate_from_id:
                # Duplicate logic: Create a new group and copy channels from source
                source_group = get_object_or_404(ChannelGroup, id=duplicate_from_id)
                channel_group = ChannelGroup.objects.create(
                    name=group_name or f"{source_group.name} (Copy)",
                    image=source_group.image,
                    sort_mode=source_group.sort_mode,
                    sort_field=source_group.sort_field
                )
                
                # Copy all channels from source group
                source_channels = Channel.objects.filter(channel_group=source_group)
                for src_chan in source_channels:
                    # Create new channel inheriting properties
                    new_chan = Channel.objects.create(
                        channel_number=src_chan.channel_number,
                        name=src_chan.name,
                        logo=src_chan.logo,
                        channel_group=channel_group,
                        tvg_id=src_chan.tvg_id,
                        tvc_guide_stationid=src_chan.tvc_guide_stationid,
                        epg_data=src_chan.epg_data,
                        stream_profile=src_chan.stream_profile,
                        user_level=src_chan.user_level,
                        is_adult=src_chan.is_adult,
                        auto_created=False, # Clones are manually managed
                        sort_order=src_chan.sort_order
                    )
                    
                    # Copy stream associations
                    channel_streams = ChannelStream.objects.filter(channel=src_chan)
                    new_channel_streams = [
                        ChannelStream(
                            channel=new_chan,
                            stream=cs.stream,
                            order=cs.order
                        )
                        for cs in channel_streams
                    ]
                    if new_channel_streams:
                        ChannelStream.objects.bulk_create(new_channel_streams)
                    
                    # Copy profile enablement status if it exists for this profile
                    src_membership = ChannelProfileMembership.objects.filter(
                        channel_profile=profile,
                        channel=src_chan
                    ).first()
                    
                    if src_membership:
                        ChannelProfileMembership.objects.create(
                            channel_profile=profile,
                            channel=new_chan,
                            enabled=src_membership.enabled
                        )
            
            elif channel_group_id:
                channel_group = get_object_or_404(ChannelGroup, id=channel_group_id)
            else:
                channel_group, _ = ChannelGroup.objects.get_or_create(name=group_name)

            # Check if already linked
            if ProfileGroup.objects.filter(profile=profile, channel_group=channel_group).exists():
                return Response(
                    {'error': 'This group is already in this profile'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            # Add at end of order
            max_order = ProfileGroup.objects.filter(profile=profile).count()
            pg = ProfileGroup.objects.create(
                profile=profile,
                channel_group=channel_group,
                order=max_order,
                is_active=True,
            )
            serializer = ProfileGroupSerializer(pg)
            return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='remove-group')
    def remove_group(self, request, pk=None):
        """Remove a group from this profile."""
        profile = self.get_object()
        channel_group_id = request.data.get('channel_group_id')
        if not channel_group_id:
            return Response(
                {'error': 'channel_group_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        pg = get_object_or_404(ProfileGroup, profile=profile, channel_group_id=channel_group_id)
        pg.delete()

        # Re-order remaining groups
        remaining = ProfileGroup.objects.filter(profile=profile).order_by('order')
        for idx, rpg in enumerate(remaining):
            if rpg.order != idx:
                rpg.order = idx
                rpg.save(update_fields=['order'])

        return Response({'status': 'removed'}, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='reorder-groups')
    def reorder_groups(self, request, pk=None):
        """Reorder groups in this profile. Expects {group_ids: [id1, id2, ...]}."""
        profile = self.get_object()
        group_ids = request.data.get('group_ids', [])
        if not group_ids:
            return Response(
                {'error': 'group_ids list is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            for idx, gid in enumerate(group_ids):
                ProfileGroup.objects.filter(
                    profile=profile, channel_group_id=gid
                ).update(order=idx)

        pgs = ProfileGroup.objects.filter(profile=profile).select_related('channel_group').order_by('order')
        serializer = ProfileGroupSerializer(pgs, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['patch'], url_path='toggle-group')
    def toggle_group(self, request, pk=None):
        """Toggle a group's active status in this profile."""
        profile = self.get_object()
        channel_group_id = request.data.get('channel_group_id')
        is_active = request.data.get('is_active')
        if channel_group_id is None or is_active is None:
            return Response(
                {'error': 'channel_group_id and is_active are required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        pg = get_object_or_404(ProfileGroup, profile=profile, channel_group_id=channel_group_id)
        pg.is_active = is_active
        pg.save(update_fields=['is_active'])
        serializer = ProfileGroupSerializer(pg)
        return Response(serializer.data)

    @action(detail=False, methods=['post'], url_path='from-source')
    def from_source(self, request):
        """Create a profile from one or more M3U sources (async)"""
        name = request.data.get('name', '').strip()
        source_ids = request.data.get('source_ids', [])
        include_channels = request.data.get('include_channels', True)

        if not name:
            return Response({'error': 'Name is required'}, status=status.HTTP_400_BAD_REQUEST)
        if not source_ids:
            return Response({'error': 'source_ids are required'}, status=status.HTTP_400_BAD_REQUEST)

        # Trigger task
        task = create_profile_from_source_task.delay(
            profile_name=name,
            source_ids=source_ids,
            user_id=request.user.id,
            include_channels=include_channels
        )

        return Response({
            'status': 'Task triggered',
            'task_id': task.id,
            'message': f"Creating profile '{name}' from sources in the background."
        }, status=status.HTTP_202_ACCEPTED)


class GetChannelStreamsAPIView(APIView):
    def get_permissions(self):
        try:
            return [
                perm() for perm in permission_classes_by_method[self.request.method]
            ]
        except KeyError:
            return [Authenticated()]

    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        # Order the streams by channelstream__order to match the order in the channel view
        streams = channel.streams.all().order_by("channelstream__order")
        serializer = StreamSerializer(streams, many=True)
        return Response(serializer.data)


class UpdateChannelMembershipAPIView(APIView):
    permission_classes = [IsOwnerOfObject]

    def patch(self, request, profile_id, channel_id):
        """Enable or disable a channel for a specific group"""
        channel_profile = get_object_or_404(ChannelProfile, id=profile_id)
        channel = get_object_or_404(Channel, id=channel_id)
        try:
            membership = ChannelProfileMembership.objects.get(
                channel_profile=channel_profile, channel=channel
            )
        except ChannelProfileMembership.DoesNotExist:
            # Create the membership if it does not exist (for custom channels)
            membership = ChannelProfileMembership.objects.create(
                channel_profile=channel_profile,
                channel=channel,
                enabled=False  # Default to False, will be updated below
            )

        serializer = ChannelProfileMembershipSerializer(
            membership, data=request.data, partial=True
        )
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class BulkUpdateChannelMembershipAPIView(APIView):
    def get_permissions(self):
        try:
            return [
                perm() for perm in permission_classes_by_method[self.request.method]
            ]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        description="Bulk enable or disable channels for a specific profile. Creates membership records if they don't exist.",
        request=BulkChannelProfileMembershipSerializer,
    )
    def patch(self, request, profile_id):
        """Bulk enable or disable channels for a specific profile"""
        # Get the channel profile
        channel_profile = get_object_or_404(ChannelProfile, id=profile_id)

        # Validate the incoming data using the serializer
        serializer = BulkChannelProfileMembershipSerializer(data=request.data)

        if serializer.is_valid():
            updates = serializer.validated_data["channels"]
            channel_ids = [entry["channel_id"] for entry in updates]

            # Validate that all channels exist
            existing_channels = set(
                Channel.objects.filter(id__in=channel_ids).values_list("id", flat=True)
            )
            invalid_channels = [cid for cid in channel_ids if cid not in existing_channels]

            if invalid_channels:
                return Response(
                    {
                        "error": "Some channels do not exist",
                        "invalid_channels": invalid_channels,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # Get existing memberships
            existing_memberships = ChannelProfileMembership.objects.filter(
                channel_profile=channel_profile, channel_id__in=channel_ids
            )
            membership_dict = {m.channel_id: m for m in existing_memberships}

            # Prepare lists for bulk operations
            memberships_to_update = []
            memberships_to_create = []

            for entry in updates:
                channel_id = entry["channel_id"]
                enabled_status = entry["enabled"]

                if channel_id in membership_dict:
                    # Update existing membership
                    membership_dict[channel_id].enabled = enabled_status
                    memberships_to_update.append(membership_dict[channel_id])
                else:
                    # Create new membership
                    memberships_to_create.append(
                        ChannelProfileMembership(
                            channel_profile=channel_profile,
                            channel_id=channel_id,
                            enabled=enabled_status,
                        )
                    )

            # Perform bulk operations
            with transaction.atomic():
                if memberships_to_update:
                    ChannelProfileMembership.objects.bulk_update(
                        memberships_to_update, ["enabled"]
                    )
                if memberships_to_create:
                    ChannelProfileMembership.objects.bulk_create(memberships_to_create)

            return Response(
                {
                    "status": "success",
                    "updated": len(memberships_to_update),
                    "created": len(memberships_to_create),
                    "invalid_channels": [],
                },
                status=status.HTTP_200_OK,
            )

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class RecurringRecordingRuleViewSet(viewsets.ModelViewSet):
    queryset = RecurringRecordingRule.objects.all().select_related("channel")
    serializer_class = RecurringRecordingRuleSerializer

    def get_permissions(self):
        return [IsAdmin()]

    def perform_create(self, serializer):
        rule = serializer.save()
        try:
            sync_recurring_rule_impl(rule.id, drop_existing=True)
        except Exception as err:
            logger.warning(f"Failed to initialize recurring rule {rule.id}: {err}")
        return rule

    def perform_update(self, serializer):
        rule = serializer.save()
        try:
            if rule.enabled:
                sync_recurring_rule_impl(rule.id, drop_existing=True)
            else:
                purge_recurring_rule_impl(rule.id)
        except Exception as err:
            logger.warning(f"Failed to resync recurring rule {rule.id}: {err}")
        return rule

    def perform_destroy(self, instance):
        rule_id = instance.id
        super().perform_destroy(instance)
        try:
            purge_recurring_rule_impl(rule_id)
        except Exception as err:
            logger.warning(f"Failed to purge recordings for rule {rule_id}: {err}")


class RecordingViewSet(viewsets.ModelViewSet):
    queryset = Recording.objects.all()
    serializer_class = RecordingSerializer

    def get_permissions(self):
        # Allow unauthenticated playback of recording files (like other streaming endpoints)
        if self.action == 'file':
            return [AllowAny()]
        try:
            return [perm() for perm in permission_classes_by_action[self.action]]
        except KeyError:
            return [Authenticated()]

    @action(detail=True, methods=["post"], url_path="comskip")
    def comskip(self, request, pk=None):
        """Trigger comskip processing for this recording."""
        from .tasks import comskip_process_recording
        rec = get_object_or_404(Recording, pk=pk)
        try:
            comskip_process_recording.delay(rec.id)
            return Response({"success": True, "queued": True})
        except Exception as e:
            return Response({"success": False, "error": str(e)}, status=400)

    @action(detail=True, methods=["get"], url_path="file")
    def file(self, request, pk=None):
        """Stream a recorded file with HTTP Range support for seeking."""
        recording = get_object_or_404(Recording, pk=pk)
        cp = recording.custom_properties or {}
        file_path = cp.get("file_path")
        file_name = cp.get("file_name") or "recording"

        if not file_path or not os.path.exists(file_path):
            raise Http404("Recording file not found")

        # Guess content type
        ext = os.path.splitext(file_path)[1].lower()
        if ext == ".mp4":
            content_type = "video/mp4"
        elif ext == ".mkv":
            content_type = "video/x-matroska"
        else:
            content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"

        file_size = os.path.getsize(file_path)
        range_header = request.META.get("HTTP_RANGE", "").strip()

        def file_iterator(path, start=0, end=None, chunk_size=8192):
            with open(path, "rb") as f:
                f.seek(start)
                remaining = (end - start + 1) if end is not None else None
                while True:
                    if remaining is not None and remaining <= 0:
                        break
                    bytes_to_read = min(chunk_size, remaining) if remaining is not None else chunk_size
                    data = f.read(bytes_to_read)
                    if not data:
                        break
                    if remaining is not None:
                        remaining -= len(data)
                    yield data

        if range_header and range_header.startswith("bytes="):
            # Parse Range header
            try:
                range_spec = range_header.split("=", 1)[1]
                start_str, end_str = range_spec.split("-", 1)
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else file_size - 1
                start = max(0, start)
                end = min(file_size - 1, end)
                length = end - start + 1

                resp = StreamingHttpResponse(
                    file_iterator(file_path, start, end),
                    status=206,
                    content_type=content_type,
                )
                resp["Content-Range"] = f"bytes {start}-{end}/{file_size}"
                resp["Content-Length"] = str(length)
                resp["Accept-Ranges"] = "bytes"
                resp["Content-Disposition"] = f"inline; filename=\"{file_name}\""
                return resp
            except Exception:
                # Fall back to full file if parsing fails
                pass

        # Full file response
        response = FileResponse(open(file_path, "rb"), content_type=content_type)
        response["Content-Length"] = str(file_size)
        response["Accept-Ranges"] = "bytes"
        response["Content-Disposition"] = f"inline; filename=\"{file_name}\""
        return response

    def destroy(self, request, *args, **kwargs):
        """Delete the Recording and ensure any active DVR client connection is closed.

        Also removes the associated file(s) from disk if present.
        """
        instance = self.get_object()

        # Attempt to close the DVR client connection for this channel if active
        try:
            channel_uuid = str(instance.channel.uuid)
            # Lazy imports to avoid module overhead if proxy isn't used
            from core.utils import RedisClient
            from apps.proxy.ts_proxy.redis_keys import RedisKeys
            from apps.proxy.ts_proxy.services.channel_service import ChannelService

            r = RedisClient.get_client()
            if r:
                client_set_key = RedisKeys.clients(channel_uuid)
                client_ids = r.smembers(client_set_key) or []
                stopped = 0
                for raw_id in client_ids:
                    try:
                        cid = raw_id.decode("utf-8") if isinstance(raw_id, (bytes, bytearray)) else str(raw_id)
                        meta_key = RedisKeys.client_metadata(channel_uuid, cid)
                        ua = r.hget(meta_key, "user_agent")
                        ua_s = ua.decode("utf-8") if isinstance(ua, (bytes, bytearray)) else (ua or "")
                        # Identify DVR recording client by its user agent
                        if ua_s and "Dispatcharr-DVR" in ua_s:
                            try:
                                ChannelService.stop_client(channel_uuid, cid)
                                stopped += 1
                            except Exception as inner_e:
                                logger.debug(f"Failed to stop DVR client {cid} for channel {channel_uuid}: {inner_e}")
                    except Exception as inner:
                        logger.debug(f"Error while checking client metadata: {inner}")
                if stopped:
                    logger.info(f"Stopped {stopped} DVR client(s) for channel {channel_uuid} due to recording cancellation")
                # If no clients remain after stopping DVR clients, proactively stop the channel
                try:
                    remaining = r.scard(client_set_key) or 0
                except Exception:
                    remaining = 0
                if remaining == 0:
                    try:
                        ChannelService.stop_channel(channel_uuid)
                        logger.info(f"Stopped channel {channel_uuid} (no clients remain)")
                    except Exception as sc_e:
                        logger.debug(f"Unable to stop channel {channel_uuid}: {sc_e}")
        except Exception as e:
            logger.debug(f"Unable to stop DVR clients for cancelled recording: {e}")

        # Capture paths before deletion
        cp = instance.custom_properties or {}
        file_path = cp.get("file_path")
        temp_ts_path = cp.get("_temp_file_path")

        # Perform DB delete first, then try to remove files
        response = super().destroy(request, *args, **kwargs)

        # Notify frontends to refresh recordings
        try:
            from core.utils import send_websocket_update
            send_websocket_update('updates', 'update', {"success": True, "type": "recordings_refreshed"})
        except Exception:
            pass

        library_dir = '/data'
        allowed_roots = ['/data/', library_dir.rstrip('/') + '/']

        def _safe_remove(path: str):
            if not path or not isinstance(path, str):
                return
            try:
                if any(path.startswith(root) for root in allowed_roots) and os.path.exists(path):
                    os.remove(path)
                    logger.info(f"Deleted recording artifact: {path}")
            except Exception as ex:
                logger.warning(f"Failed to delete recording artifact {path}: {ex}")

        _safe_remove(file_path)
        _safe_remove(temp_ts_path)

        return response


class ComskipConfigAPIView(APIView):
    """Upload or inspect the custom comskip.ini used by DVR processing."""

    parser_classes = [MultiPartParser, FormParser]

    def get_permissions(self):
        return [IsAdmin()]

    def get(self, request):
        path = CoreSettings.get_dvr_comskip_custom_path()
        exists = bool(path and os.path.exists(path))
        return Response({"path": path, "exists": exists})

    def post(self, request):
        uploaded = request.FILES.get("file") or request.FILES.get("comskip_ini")
        if not uploaded:
            return Response({"error": "No file provided"}, status=status.HTTP_400_BAD_REQUEST)

        name = (uploaded.name or "").lower()
        if not name.endswith(".ini"):
            return Response({"error": "Only .ini files are allowed"}, status=status.HTTP_400_BAD_REQUEST)

        if uploaded.size and uploaded.size > 1024 * 1024:
            return Response({"error": "File too large (limit 1MB)"}, status=status.HTTP_400_BAD_REQUEST)

        dest_dir = os.path.join(settings.MEDIA_ROOT, "comskip")
        os.makedirs(dest_dir, exist_ok=True)
        dest_path = os.path.join(dest_dir, "comskip.ini")

        try:
            with open(dest_path, "wb") as dest:
                for chunk in uploaded.chunks():
                    dest.write(chunk)
        except Exception as e:
            logger.error(f"Failed to save uploaded comskip.ini: {e}")
            return Response({"error": "Unable to save file"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        # Persist path setting so DVR processing picks it up immediately
        CoreSettings.set_dvr_comskip_custom_path(dest_path)

        return Response({"success": True, "path": dest_path, "exists": os.path.exists(dest_path)})


class BulkDeleteUpcomingRecordingsAPIView(APIView):
    """Delete all upcoming (future) recordings."""
    def get_permissions(self):
        try:
            return [perm() for perm in permission_classes_by_method[self.request.method]]
        except KeyError:
            return [Authenticated()]

    def post(self, request):
        now = timezone.now()
        qs = Recording.objects.filter(start_time__gt=now)
        removed = qs.count()
        qs.delete()
        try:
            from core.utils import send_websocket_update
            send_websocket_update('updates', 'update', {"success": True, "type": "recordings_refreshed", "removed": removed})
        except Exception:
            pass
        return Response({"success": True, "removed": removed})


class SeriesRulesAPIView(APIView):
    """Manage DVR series recording rules (list/add)."""
    def get_permissions(self):
        try:
            return [perm() for perm in permission_classes_by_method[self.request.method]]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        summary="List all series rules",
        description="Retrieve all configured DVR series recording rules.",
    )
    def get(self, request):
        return Response({"rules": CoreSettings.get_dvr_series_rules()})

    @extend_schema(
        summary="Create or update a series rule",
        description="Add a new series recording rule or update an existing one. Rules will be evaluated immediately to find matching episodes.",
        request=inline_serializer(
            name="SeriesRuleRequest",
            fields={
                'tvg_id': serializers.CharField(help_text='Channel TVG ID'),
                'mode': serializers.ChoiceField(choices=['all', 'new'], default='all', help_text='all: record all episodes, new: record only new episodes'),
                'title': serializers.CharField(help_text='Series title', required=False),
            },
        ),
    )
    def post(self, request):
        data = request.data or {}
        tvg_id = str(data.get("tvg_id") or "").strip()
        mode = (data.get("mode") or "all").lower()
        title = data.get("title") or ""
        if mode not in ("all", "new"):
            return Response({"error": "mode must be 'all' or 'new'"}, status=status.HTTP_400_BAD_REQUEST)
        if not tvg_id:
            return Response({"error": "tvg_id is required"}, status=status.HTTP_400_BAD_REQUEST)
        rules = CoreSettings.get_dvr_series_rules()
        # Upsert by tvg_id
        existing = next((r for r in rules if str(r.get("tvg_id")) == tvg_id), None)
        if existing:
            existing.update({"mode": mode, "title": title})
        else:
            rules.append({"tvg_id": tvg_id, "mode": mode, "title": title})
        CoreSettings.set_dvr_series_rules(rules)
        # Evaluate immediately for this tvg_id (async)
        try:
            evaluate_series_rules.delay(tvg_id)
        except Exception:
            pass
        return Response({"success": True, "rules": rules})


class DeleteSeriesRuleAPIView(APIView):
    def get_permissions(self):
        try:
            return [perm() for perm in permission_classes_by_method[self.request.method]]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        summary="Delete a series rule",
        description="Remove a series recording rule by TVG ID. This does not remove already scheduled recordings.",
        parameters=[
            OpenApiParameter('tvg_id', str, OpenApiParameter.PATH, required=True, description='Channel TVG ID'),
        ],
    )
    def delete(self, request, tvg_id):
        tvg_id = unquote(str(tvg_id or ""))
        rules = [r for r in CoreSettings.get_dvr_series_rules() if str(r.get("tvg_id")) != tvg_id]
        CoreSettings.set_dvr_series_rules(rules)
        return Response({"success": True, "rules": rules})


class EvaluateSeriesRulesAPIView(APIView):
    def get_permissions(self):
        try:
            return [perm() for perm in permission_classes_by_method[self.request.method]]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        summary="Evaluate series rules",
        description="Trigger evaluation of series recording rules to find and schedule matching episodes. Can evaluate all rules or a specific channel.",
        request=inline_serializer(
            name="EvaluateSeriesRulesRequest",
            fields={
                "tvg_id": serializers.CharField(required=False, help_text="Optional: evaluate only rules for this channel TVG ID. If omitted, all rules are evaluated."),
            },
        ),
    )
    def post(self, request):
        tvg_id = request.data.get("tvg_id")
        # Run synchronously so UI sees results immediately
        result = evaluate_series_rules_impl(str(tvg_id)) if tvg_id else evaluate_series_rules_impl()
        return Response({"success": True, **result})


class BulkRemoveSeriesRecordingsAPIView(APIView):
    """Bulk remove scheduled recordings for a series rule.

    POST body:
      - tvg_id: required (EPG channel id)
      - title: optional (series title)
      - scope: 'title' (default) or 'channel'
    """
    def get_permissions(self):
        try:
            return [perm() for perm in permission_classes_by_method[self.request.method]]
        except KeyError:
            return [Authenticated()]

    @extend_schema(
        summary="Bulk remove scheduled recordings for a series",
        description="Delete future scheduled recordings for a series rule. Useful for stopping a rule without losing the configuration. Matches by channel and optionally by series title.",
        request=inline_serializer(
            name="BulkRemoveSeriesRecordingsRequest",
            fields={
                "tvg_id": serializers.CharField(required=True, help_text="Channel TVG ID (required)"),
                "title": serializers.CharField(required=False, help_text="Series title - when scope=title, only recordings matching this title are removed"),
                "scope": serializers.ChoiceField(choices=["title", "channel"], default="title", required=False, help_text="title: remove only matching title on channel, channel: remove all future recordings on channel"),
            },
        ),
    )
    def post(self, request):
        from django.utils import timezone
        tvg_id = str(request.data.get("tvg_id") or "").strip()
        title = request.data.get("title")
        scope = (request.data.get("scope") or "title").lower()
        if not tvg_id:
            return Response({"error": "tvg_id is required"}, status=status.HTTP_400_BAD_REQUEST)

        qs = Recording.objects.filter(
            start_time__gte=timezone.now(),
            custom_properties__program__tvg_id=tvg_id,
        )
        if scope == "title" and title:
            qs = qs.filter(custom_properties__program__title=title)

        count = qs.count()
        qs.delete()
        try:
            from core.utils import send_websocket_update
            send_websocket_update('updates', 'update', {"success": True, "type": "recordings_refreshed", "removed": count})
        except Exception:
            pass
        return Response({"success": True, "removed": count})
