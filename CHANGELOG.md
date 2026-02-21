# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Backend: New `match-epg-from-streams` endpoint to bulk-match channels to EPG data using their primary stream's `tvg_id`. Fixes channels that were created before the auto-update fix.

## [0.7.1] - 2026-02-21

### Fixed

- Backend: Channel EPG data (`tvg_id` and `epg_data`) now auto-updates when the primary stream is changed or remapped to a different source.

## [0.7.0] - 2026-02-21

### Added

- New HLS output proxy endpoint (`/proxy/hls/stream/<uuid>`) that transcodes source TS streams to proper HLS with AC3/EAC3 audio converted to AAC. Enables Roku Ultra and other devices that lack AC3 decoding support.

## [0.6.0] - 2026-02-21

### Changed

- Backend: Remap Channels now matches destination streams by **channel name** (case-insensitive) when `tvg_id` matching fails, significantly improving remap success rates for sources with missing or inconsistent tvg_ids.
- Frontend: Updated Remap Channels modal description to reflect the new tvg_id + name matching behavior.

## [0.5.2] - 2026-02-20

### Fixed

- Backend: Fixed Xtream account streams missing `tvg_id` — the provider's `epg_channel_id` was used for hash generation but never stored on the Stream object. Streams now get `tvg_id` populated on discovery and updated on refresh.

## [0.5.1] - 2026-02-20

### Fixed

- Backend: Fixed `bulk-sync` endpoint crash (`ValueError: The annotation 'channel_group' conflicts with a field on the model`) by querying FK `_id` columns directly instead of using `F()` annotations that conflict with model field names.

## [0.5.0] - 2026-02-20

### Fixed

- Backend/Frontend: Fixed stream sync not populating all streams into the frontend local database. The backend `StreamPagination.max_page_size` (1000) was silently capping the frontend's requested `page_size` (5000), causing only a fraction of streams to be synced.

### Added

- Backend: Added lightweight `/api/channels/streams/bulk-sync/` endpoint that returns only the fields needed by the Stream Library (8 vs 24 fields), bypassing the serializer for maximum speed.

### Changed

- Frontend: Stream Library sync now fetches up to 3 pages in parallel for significantly faster sync times.
- Frontend: Sync loop is now response-driven (tracks actual results received) instead of pre-calculating pages from batch size, making it robust against any page size capping.
- Backend: Increased `StreamPagination.max_page_size` from 1000 to 5000 to match frontend batch sync size.

## [0.4.0] - 2026-02-20

### Added

- Frontend: Added `stream_source` filtering support to `GroupChannelsPanel`.

### Changed

- Backend: Migrated internal cache from `LocMemCache` to `RedisCache` for shared availability across uwsgi, celery, and daphne.
- Backend: Optimized stream querying in `generate_m3u` and `generate_epg` by using `Prefetch` to eliminate N+1 queries.
- Frontend: Improved dropdown source UI grouping in `RemapChannelsModal` to properly categorize and display M3U and Xtream sources.
- Frontend: Improved robustness of `get_ids` API method to handle raw array responses gracefully.

## [0.3.0] - 2026-02-20

### Added

- Backend: Added `_build_xc_channel_num_map` helper to produce collision-free integer channel numbers for XC clients.
- Backend: Standardized host/port/scheme resolution and added/normalized server/user fields required by XC responses.
- Frontend: `GroupChannelsPanel` now supports inline double-click rename with keyboard handling and focus behavior.
- Frontend: Added defensive null-safety for playlists in `GroupChannelsPanel` and `StreamLibraryPanel`.

### Changed

- Backend: Optimized queries using `select_related` for channel groups and cached default group lookup.
- Backend: Prefetched M3U episode relations in `xc_get_series_info` to avoid N+1 queries.
- Frontend: `M3UProfile` now avoids redundant websocket sends and debounces change detection.
- Frontend: Replaced `dangerouslySetInnerHTML` with safe React elements for highlighting in `M3UProfile`.
- Frontend: Debounced `max_streams` updates in `M3UProfiles`.
- Tables (EPGs, M3Us, StreamProfiles): Various optimizations including strict equality checks, improved sorting, and memoization.
- Stores: Playlists store now treats non-array API responses as an empty array.

### Fixed

- Frontend: Fixed `User-Agent` select binding in `StreamProfile`.
- Stores: Fixed playlist removal to also clear related profiles and corrected a typo in the `streamProfiles` removal API.
- General: Added defensive null-safety and normalized API responses to avoid runtime errors.

## [0.2.0] - 2026-02-20

### Added

- Backend: Added channel `stream_source` filtering.
- Added `/ids` endpoint and a `remap` action to `ChannelViewSet` to swap streams by `tvg_id`.
- Added `clear_vod_for_account` and `clear_vod_for_category` Celery tasks.

### Changed

- Wired VOD enable/disable flows in `M3UAccountViewSet`, including an explicit `clear-vod` action and category disable cleanup.
- Refined output endpoints to only return channels with active or custom streams.
- Updated profile creation to ignore inactive M3U accounts when creating from sources.

## [0.1.1] - 2026-02-15

### Fixed

- Fixed a `NameError` in XC API `get_live_categories` where `request` was not defined.
- Fixed a `FieldError` in XC API `get_vod_categories` and `get_series_categories` caused by non-existent `image` field in `VODCategory` model.

## [0.1.0] - 2026-02-14

### Added

- Included `uuid` in Xtream Codes (XC) API responses for Live, VOD, and Series/Episodes. This allows external clients to reconstruct the exact same URLs used in the Dispatcharr dashboard.
- Added `series_uuid` to single series info and `stream_uuid` to movie info in the XC API for better data mapping.

## [0.0.2] - 2026-02-14

### Changed

- Updated menu labels to better reflect functionality:
  - "M3U & EPG Manager" → "M3U/XC/EPG Manager"
  - "M3U Accounts" → "M3U and XC Accounts"
  - "Add M3U" button → "Add Account"

### Removed

- Completely removed credits system from user management
  - Removed credits display from sidebar
  - Removed credits fields from user forms
  - Removed credits column from users table
  - Removed credits validation from bulk user generation

## [0.0.1] - 2026-02-14

### Initial Fork Release

This is the initial release of the Dispatcharr fork, featuring a complete rebuild with advanced stream hosting and management capabilities.

#### Key Features

- **All-New Profile Management**: Intuitive drag-and-drop interface for organizing and managing profiles with ease
- **Advanced User Management**: Per-user connection limits (Redis-backed) and account expiration
- **Full Xtream Codes API**: High-performance implementation for wide client compatibility
- **Proxy Security**: Authenticated playback tracking across both M3U and XC protocols
- **Group Management**: Enhanced group organization with hide/show functionality
- **Stream Management**: Comprehensive stream organization and filtering capabilities
- **EPG Integration**: Advanced EPG matching and management
- **VOD Support**: Complete Video on Demand system with movies and TV series
- **DVR System**: Recording and playback capabilities
- **Plugin System**: Extensible framework for custom functionality
- **Logo Management**: Comprehensive logo management with deduplication
- **Network Access Control**: CIDR-based network restrictions
- **Hardware Acceleration**: Support for NVIDIA, Intel QSV, and VAAPI
- **Multiple Streaming Backends**: VLC, FFmpeg, and Streamlink support

#### Technical Highlights

- Built on Django 5.2+ with React frontend
- Redis-backed connection management
- PostgreSQL database with optimized queries
- WebSocket support for real-time updates
- Docker-based deployment with multi-architecture support (ARM/AMD64)
- Comprehensive API with OpenAPI 3.0 documentation

#### License Compliance

This fork is released under CC BY-NC-SA 4.0 license, ensuring non-commercial use only. All features have been reviewed and modified to comply with license requirements.
