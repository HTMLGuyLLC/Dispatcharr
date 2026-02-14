from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import Group, Permission
from django.http import JsonResponse, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework.decorators import api_view, permission_classes, action
from rest_framework.response import Response
from rest_framework import viewsets, status, serializers
from drf_spectacular.utils import extend_schema, OpenApiParameter, inline_serializer
from drf_spectacular.types import OpenApiTypes
import json
from .permissions import IsAdmin, Authenticated
from dispatcharr.utils import network_access_allowed

from .models import User
from .serializers import UserSerializer, GroupSerializer, PermissionSerializer
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView
from core.xtream_codes import Client as XCClient
from apps.xtream.models import XtreamAccount
from apps.m3u.models import M3UAccount
from apps.channels.models import ChannelProfile, Stream
from datetime import datetime


class TokenObtainPairView(TokenObtainPairView):
    def post(self, request, *args, **kwargs):
        # Custom logic here
        if not network_access_allowed(request, "UI"):
            # Log blocked login attempt due to network restrictions
            from core.utils import log_system_event
            username = request.data.get("username", 'unknown')
            client_ip = request.META.get('REMOTE_ADDR', 'unknown')
            user_agent = request.META.get('HTTP_USER_AGENT', 'unknown')
            log_system_event(
                event_type='login_failed',
                user=username,
                client_ip=client_ip,
                user_agent=user_agent,
                reason='Network access denied',
            )
            return Response({"error": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)

        # Get the response from the parent class first
        username = request.data.get("username")

        # Log login attempt
        from core.utils import log_system_event
        client_ip = request.META.get('REMOTE_ADDR', 'unknown')
        user_agent = request.META.get('HTTP_USER_AGENT', 'unknown')

        try:
            response = super().post(request, *args, **kwargs)

            # If login was successful, update last_login and log success
            if response.status_code == 200:
                if username:
                    from django.utils import timezone
                    try:
                        user = User.objects.get(username=username)
                        user.last_login = timezone.now()
                        user.save(update_fields=['last_login'])

                        # Log successful login
                        log_system_event(
                            event_type='login_success',
                            user=username,
                            client_ip=client_ip,
                            user_agent=user_agent,
                        )
                    except User.DoesNotExist:
                        pass  # User doesn't exist, but login somehow succeeded
            else:
                # Log failed login attempt
                log_system_event(
                    event_type='login_failed',
                    user=username or 'unknown',
                    client_ip=client_ip,
                    user_agent=user_agent,
                    reason='Invalid credentials',
                )

            return response

        except Exception as e:
            # If parent class raises an exception (e.g., validation error), log failed attempt
            log_system_event(
                event_type='login_failed',
                user=username or 'unknown',
                client_ip=client_ip,
                user_agent=user_agent,
                reason=f'Authentication error: {str(e)[:100]}',
            )
            raise  # Re-raise the exception to maintain normal error flow


class TokenRefreshView(TokenRefreshView):
    def post(self, request, *args, **kwargs):
        # Custom logic here
        if not network_access_allowed(request, "UI"):
            # Log blocked token refresh attempt due to network restrictions
            from core.utils import log_system_event
            client_ip = request.META.get('REMOTE_ADDR', 'unknown')
            user_agent = request.META.get('HTTP_USER_AGENT', 'unknown')
            log_system_event(
                event_type='login_failed',
                user='token_refresh',
                client_ip=client_ip,
                user_agent=user_agent,
                reason='Network access denied (token refresh)',
            )
            return Response({"error": "Unauthorized"}, status=status.HTTP_403_FORBIDDEN)

        return super().post(request, *args, **kwargs)


@csrf_exempt  # In production, consider CSRF protection strategies or ensure this endpoint is only accessible when no superuser exists.
def initialize_superuser(request):
    # If a superuser already exists, always indicate that
    if User.objects.filter(is_superuser=True).exists():
        return JsonResponse({"superuser_exists": True})

    if request.method == "POST":
        try:
            data = json.loads(request.body)
            username = data.get("username")
            password = data.get("password")
            email = data.get("email", "")
            xc_password = data.get("xc_password", "")
            if not username or not password:
                return JsonResponse(
                    {"error": "Username and password are required."}, status=400
                )
            
            custom_properties = {}
            if xc_password:
                custom_properties["xc_password"] = xc_password

            # Create the superuser
            User.objects.create_superuser(
                username=username, 
                password=password, 
                email=email, 
                user_level=10,
                custom_properties=custom_properties
            )
            return JsonResponse({"superuser_exists": True})
        except Exception as e:
            return JsonResponse({"error": str(e)}, status=500)
    # For GET requests, indicate no superuser exists
    return JsonResponse({"superuser_exists": False})


# 🔹 1) Authentication APIs
class AuthViewSet(viewsets.ViewSet):
    """Handles user login and logout"""

    def get_permissions(self):
        """
        Login doesn't require auth, but logout does
        """
        if self.action == 'logout':
            from rest_framework.permissions import IsAuthenticated
            return [IsAuthenticated()]
        return []

    @extend_schema(
        description="Authenticate and log in a user",
        request=inline_serializer(
            name="LoginRequest",
            fields={
                "username": serializers.CharField(),
                "password": serializers.CharField(),
            },
        ),
    )
    def login(self, request):
        """Logs in a user and returns user details"""
        username = request.data.get("username")
        password = request.data.get("password")
        user = authenticate(request, username=username, password=password)

        # Get client info for logging
        from core.utils import log_system_event
        client_ip = request.META.get('REMOTE_ADDR', 'unknown')
        user_agent = request.META.get('HTTP_USER_AGENT', 'unknown')

        if user:
            login(request, user)
            # Update last_login timestamp
            from django.utils import timezone
            user.last_login = timezone.now()
            user.save(update_fields=['last_login'])

            # Log successful login
            log_system_event(
                event_type='login_success',
                user=username,
                client_ip=client_ip,
                user_agent=user_agent,
            )

            return Response(
                {
                    "message": "Login successful",
                    "user": {
                        "id": user.id,
                        "username": user.username,
                        "email": user.email,
                        "groups": list(user.groups.values_list("name", flat=True)),
                    },
                }
            )

        # Log failed login attempt
        log_system_event(
            event_type='login_failed',
            user=username or 'unknown',
            client_ip=client_ip,
            user_agent=user_agent,
            reason='Invalid credentials',
        )
        return Response({"error": "Invalid credentials"}, status=400)

    @extend_schema(
        description="Log out the current user",
    )
    def logout(self, request):
        """Logs out the authenticated user"""
        # Log logout event before actually logging out
        from core.utils import log_system_event
        username = request.user.username if request.user and request.user.is_authenticated else 'unknown'
        client_ip = request.META.get('REMOTE_ADDR', 'unknown')
        user_agent = request.META.get('HTTP_USER_AGENT', 'unknown')

        log_system_event(
            event_type='logout',
            user=username,
            client_ip=client_ip,
            user_agent=user_agent,
        )

        logout(request)
        return Response({"message": "Logout successful"})


# 🔹 2) User Management APIs
class UserViewSet(viewsets.ModelViewSet):
    """Handles CRUD operations for Users"""

    serializer_class = UserSerializer

    def get_queryset(self):
        user = self.request.user
        if user.is_anonymous:
            return User.objects.none()

        if user.user_level >= User.UserLevel.ADMIN:
            return User.objects.all().prefetch_related("channel_profiles")

        return User.objects.filter(id=user.id).prefetch_related("channel_profiles")

    def get_permissions(self):
        from .permissions import IsAdmin, Authenticated
        if self.action == "me":
            return [Authenticated()]
        
        if self.action in ["list", "retrieve", "update", "partial_update", "destroy", "bulk_generate"]:
            return [IsAdmin()]

        return [IsAdmin()]



    @extend_schema(
        description="Retrieve a list of users",
        responses={200: UserSerializer(many=True)},
    )
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @extend_schema(description="Retrieve a specific user by ID")
    def retrieve(self, request, *args, **kwargs):
        return super().retrieve(request, *args, **kwargs)

    @extend_schema(description="Create a new user")
    def create(self, request, *args, **kwargs):
        return super().create(request, *args, **kwargs)

    @extend_schema(description="Update a user")
    def update(self, request, *args, **kwargs):
        return super().update(request, *args, **kwargs)

    @extend_schema(description="Delete a user")
    def destroy(self, request, *args, **kwargs):
        return super().destroy(request, *args, **kwargs)

    @extend_schema(
        description="Get active user information",
    )
    @action(detail=False, methods=["get"], url_path="me")
    def me(self, request):
        user = request.user
        serializer = UserSerializer(user)
        return Response(serializer.data)

    @extend_schema(
        description="Bulk generate users",
        request=inline_serializer(
            name="BulkGenerateRequest",
            fields={
                "count": serializers.IntegerField(default=10),
                "password_length": serializers.IntegerField(default=8),
                "connection_limit": serializers.IntegerField(default=1),
                "expires_in_days": serializers.IntegerField(default=30),
                "user_level": serializers.IntegerField(default=User.UserLevel.STREAMER),
                "channel_profile_ids": serializers.ListField(
                    child=serializers.IntegerField(),
                    required=False,
                    allow_empty=True
                ),
                "exclude_mature": serializers.BooleanField(default=False),
            },
        ),
    )
    @action(detail=False, methods=["post"], url_path="bulk_generate")
    def bulk_generate(self, request):
        import string
        import random
        from django.utils import timezone
        from datetime import timedelta

        count = int(request.data.get("count", 10))
        password_length = int(request.data.get("password_length", 8))
        connection_limit = int(request.data.get("connection_limit", 1))
        expires_in_days = int(request.data.get("expires_in_days", 30))
        user_level = int(request.data.get("user_level", User.UserLevel.STREAMER))

        users_to_create = count
        
        channel_profile_ids = request.data.get("channel_profile_ids", [])
        exclude_mature = request.data.get("exclude_mature", False)
        channel_profiles = []
        
        if channel_profile_ids:
            try:
                channel_profiles = list(ChannelProfile.objects.filter(id__in=channel_profile_ids))
                
                # If exclude_mature is enabled, create filtered versions of the profiles
                if exclude_mature:
                    filtered_profiles = []
                    for channel_profile in channel_profiles:
                        # Create a temporary profile name
                        temp_profile_name = f"{channel_profile.name} (No Mature Content)"
                        
                        # Check if a filtered profile already exists
                        filtered_profile, created = ChannelProfile.objects.get_or_create(
                            name=temp_profile_name,
                            created_by=request.user,
                            defaults={'name': temp_profile_name}
                        )
                        
                        if created:
                            # Copy all non-adult channels from the source profile to the filtered profile
                            from apps.channels.models import ChannelProfileMembership, Channel
                            source_memberships = ChannelProfileMembership.objects.filter(
                                channel_profile=channel_profile
                            ).select_related('channel')
                            
                            filtered_memberships = [
                                ChannelProfileMembership(
                                    channel_profile=filtered_profile,
                                    channel=membership.channel,
                                    enabled=membership.enabled
                                )
                                for membership in source_memberships
                                if not membership.channel.is_adult
                            ]
                            
                            if filtered_memberships:
                                ChannelProfileMembership.objects.bulk_create(
                                    filtered_memberships,
                                    ignore_conflicts=True
                                )
                        
                        filtered_profiles.append(filtered_profile)
                    
                    # Use the filtered profiles instead
                    channel_profiles = filtered_profiles
                    
            except Exception:
                pass
        elif exclude_mature:
            # No specific profile selected, but exclude_mature is enabled
            # Create a profile with all non-adult channels
            temp_profile_name = f"All Channels (No Mature Content) - {request.user.username}"
            
            filtered_profile, created = ChannelProfile.objects.get_or_create(
                name=temp_profile_name,
                created_by=request.user,
                defaults={'name': temp_profile_name}
            )
            
            if created:
                from apps.channels.models import ChannelProfileMembership, Channel
                all_channels = Channel.objects.filter(is_adult=False)
                
                filtered_memberships = [
                    ChannelProfileMembership(
                        channel_profile=filtered_profile,
                        channel=channel,
                        enabled=True
                    )
                    for channel in all_channels
                ]
                
                if filtered_memberships:
                    ChannelProfileMembership.objects.bulk_create(
                        filtered_memberships,
                        ignore_conflicts=True
                    )
            
            channel_profiles = [filtered_profile]

        created_users = []
        for _ in range(users_to_create):
            # Generate completely random username
            username = "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
            password = "".join(random.choices(string.ascii_letters + string.digits, k=password_length))
            
            expires_at = timezone.now() + timedelta(days=expires_in_days)
            
            new_user = User.objects.create(
                username=username,
                connection_limit=connection_limit,
                expires_at=expires_at,
                user_level=user_level,
                custom_properties={"xc_password": password}
            )
            new_user.set_password(password)
            
            # Add all selected channel profiles
            if channel_profiles:
                new_user.channel_profiles.add(*channel_profiles)
                
            new_user.save()
            
            created_users.append({
                "username": username,
                "password": password,
                "expires_at": expires_at.isoformat()
            })

        return Response({
            "created": created_users, 
            "count": len(created_users),
            "requested": count
        }, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["post"], url_path="validate_xc_credentials")
    def validate_xc_credentials(self, request):
        """
        Validate XC credentials against a source XC server found in the provided profiles.
        """
        username = request.data.get("xc_username")
        password = request.data.get("xc_password")
        profile_ids = request.data.get("profile_ids", [])

        if not username or not password:
            return Response({"error": "XC Username and Password are required"}, status=400)

        # Find a suitable XC-compatible server from the profiles
        source_server = None
        if profile_ids:
            # 1. Look for an XtreamAccount through streams in these profiles
            stream = Stream.objects.filter(
                channel_group__profile_groups__profile_id__in=profile_ids,
                xtream_account__isnull=False
            ).first()
            if stream:
                source_server = stream.xtream_account
            
            if not source_server:
                # 2. Look for an M3UAccount (type XC) through channels in these profiles
                stream = Stream.objects.filter(
                    channels__channelprofilemembership__channel_profile_id__in=profile_ids,
                    m3u_account__account_type="XC"
                ).first()
                if stream:
                    source_server = stream.m3u_account

        if not source_server:
            # Fallback to any active account
            source_server = XtreamAccount.objects.filter(status=XtreamAccount.Status.IDLE).first()
            if not source_server:
                source_server = M3UAccount.objects.filter(account_type="XC").first()

        if not source_server:
            return Response({"error": "No source XC server found in selected profiles"}, status=404)

        try:
            with XCClient(source_server.server_url, username, password) as client:
                auth_data = client.authenticate()
                user_info = auth_data.get('user_info', {})
                
                exp_date = user_info.get('exp_date')
                if exp_date:
                    try:
                        exp_date = datetime.fromtimestamp(int(exp_date)).isoformat()
                    except (ValueError, TypeError):
                        exp_date = None

                return Response({
                    "success": True,
                    "max_connections": user_info.get('max_connections'),
                    "exp_date": exp_date,
                    "server_name": source_server.name
                })
        except Exception as e:
            return Response({"error": f"Failed to authenticate with {source_server.name}: {str(e)}"}, status=400)

    @action(detail=True, methods=["post"], url_path="sync_xc_info")
    def sync_xc_info(self, request, pk=None):
        """
        Force sync XC info for a specific user.
        """
        user = self.get_object()
        success = user.sync_xc_account_info()
        
        if success:
            return Response({
                "success": True, 
                "connection_limit": user.connection_limit,
                "expires_at": user.expires_at.isoformat() if user.expires_at else None
            })
        return Response({"error": "Failed to sync XC info"}, status=400)


# 🔹 3) Group Management APIs
class GroupViewSet(viewsets.ModelViewSet):
    """Handles CRUD operations for Groups"""

    queryset = Group.objects.all()
    serializer_class = GroupSerializer
    permission_classes = [Authenticated]

    @extend_schema(
        description="Retrieve a list of groups",
        responses={200: GroupSerializer(many=True)},
    )
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @extend_schema(description="Retrieve a specific group by ID")
    def retrieve(self, request, *args, **kwargs):
        return super().retrieve(request, *args, **kwargs)

    @extend_schema(description="Create a new group")
    def create(self, request, *args, **kwargs):
        return super().create(request, *args, **kwargs)

    @extend_schema(description="Update a group")
    def update(self, request, *args, **kwargs):
        return super().update(request, *args, **kwargs)

    @extend_schema(description="Delete a group")
    def destroy(self, request, *args, **kwargs):
        return super().destroy(request, *args, **kwargs)


# 🔹 4) Permissions List API
@extend_schema(
    description="Retrieve a list of all permissions",
    responses={200: PermissionSerializer(many=True)},
)
@api_view(["GET"])
@permission_classes([Authenticated])
def list_permissions(request):
    """Returns a list of all available permissions"""
    permissions = Permission.objects.all()
    serializer = PermissionSerializer(permissions, many=True)
    return Response(serializer.data)
