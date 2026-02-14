"""
Stream generation and client-side handling for TS streams.
This module handles generating and delivering video streams to clients.
"""

import time
import logging
import threading
import gevent  # Add this import at the top of your file
from apps.proxy.config import TSConfig as Config
from apps.channels.models import Channel
from core.utils import log_system_event
from .server import ProxyServer
from .utils import create_ts_packet, get_logger
from .redis_keys import RedisKeys
from .constants import ChannelMetadataField
from .config_helper import ConfigHelper  # Add this import

logger = get_logger()

class StreamGenerator:
    """
    Handles generating streams for clients, including initialization,
    data delivery, and cleanup.
    """

    def __init__(self, channel_id, client_id, client_ip, client_user_agent, channel_initializing=False, user_id=None):
        """
        Initialize the stream generator with client and channel details.

        Args:
            channel_id: The UUID of the channel to stream
            client_id: Unique ID for this client connection
            client_ip: Client's IP address
            client_user_agent: User agent string from client
            channel_initializing: Whether the channel is still initializing
            user_id: ID of the authenticated user
        """
        self.channel_id = channel_id
        self.client_id = client_id
        self.client_ip = client_ip
        self.client_user_agent = client_user_agent
        self.channel_initializing = channel_initializing
        self.user_id = user_id

        # Performance and state tracking
        self.stream_start_time = time.time()
        self.bytes_sent = 0
        self.chunks_sent = 0
        self.local_index = 0
        self.consecutive_empty = 0

        # Add tracking for current transfer rate calculation
        self.last_stats_time = time.time()
        self.last_stats_bytes = 0
        self.current_rate = 0.0

        # TTL refresh tracking
        self.last_ttl_refresh = time.time()
        self.ttl_refresh_interval = 3  # Refresh TTL every 3 seconds of active streaming

    def generate(self):
        """
        Generator function that produces the stream content for the client.
        Handles initialization state, data delivery, and client disconnection.

        Yields:
            bytes: Chunks of TS stream data
        """
        self.stream_start_time = time.time()
        self.bytes_sent = 0
        self.chunks_sent = 0

        try:
            logger.info(f"[{self.client_id}] Stream generator started, channel_ready={not self.channel_initializing}")

            # First handle initialization if needed
            if self.channel_initializing:
                # Need to use a closure or similar to yield from inside the method
                for packet in self._wait_for_initialization_gen():
                    yield packet
                
                # Check if initialization actually succeeded
                proxy_server = ProxyServer.get_instance()
                metadata_key = RedisKeys.channel_metadata(self.channel_id)
                metadata = proxy_server.redis_client.hgetall(metadata_key)
                if not metadata or b'state' not in metadata or metadata[b'state'].decode('utf-8') not in ['waiting_for_clients', 'active']:
                    return

            # Channel is now ready - start normal streaming
            logger.info(f"[{self.client_id}] Channel {self.channel_id} ready, starting normal streaming")

            # Reset start time for real streaming
            self.stream_start_time = time.time()

            # Setup streaming parameters and verify resources
            if not self._setup_streaming():
                return

            # Log client connect event
            try:
                channel_obj = Channel.objects.get(uuid=self.channel_id)
                log_system_event(
                    'client_connect',
                    channel_id=self.channel_id,
                    channel_name=channel_obj.name,
                    client_ip=self.client_ip,
                    client_id=self.client_id,
                    user_agent=self.client_user_agent[:100] if self.client_user_agent else None
                )
            except Exception as e:
                logger.error(f"Could not log client connect event: {e}")

            # Main streaming loop
            for chunk in self._stream_data_generator():
                yield chunk

        except Exception as e:
            logger.error(f"[{self.client_id}] Stream error: {e}", exc_info=True)
        finally:
            self._cleanup()

    def _wait_for_initialization_gen(self):
        """Generator version of wait_for_initialization to allow yielding packets."""
        initialization_start = time.time()
        max_init_wait = ConfigHelper.client_wait_timeout()
        keepalive_interval = 0.5
        last_keepalive = 0
        proxy_server = ProxyServer.get_instance()

        while time.time() - initialization_start < max_init_wait:
            if proxy_server.redis_client:
                metadata_key = RedisKeys.channel_metadata(self.channel_id)
                metadata = proxy_server.redis_client.hgetall(metadata_key)

                if metadata and b'state' in metadata:
                    state = metadata[b'state'].decode('utf-8')
                    if state in ['waiting_for_clients', 'active']:
                        logger.info(f"[{self.client_id}] Channel {self.channel_id} now ready (state={state})")
                        return # Success
                    elif state in ['error', 'stopped', 'stopping']:
                        error_message = metadata.get(b'error_message', b'Unknown error').decode('utf-8')
                        logger.error(f"[{self.client_id}] Channel {self.channel_id} in error state: {state}, message: {error_message}")
                        yield create_ts_packet('error', f"Error: {error_message}")
                        return # Failure
                    else:
                        if time.time() - last_keepalive >= keepalive_interval:
                            keepalive_packet = create_ts_packet('keepalive', f"Initializing: {state}")
                            yield keepalive_packet
                            self.bytes_sent += len(keepalive_packet)
                            last_keepalive = time.time()

                stop_key = RedisKeys.channel_stopping(self.channel_id)
                if proxy_server.redis_client.exists(stop_key):
                    yield create_ts_packet('error', "Error: Channel is stopping")
                    return

            gevent.sleep(0.1)

        logger.warning(f"[{self.client_id}] Timed out waiting for initialization")
        yield create_ts_packet('error', "Error: Initialization timeout")

    def _setup_streaming(self):
        """Setup streaming parameters and check resources."""
        proxy_server = ProxyServer.get_instance()

        # Get buffer - stream manager may not exist in this worker
        buffer = proxy_server.stream_buffers.get(self.channel_id)
        stream_manager = proxy_server.stream_managers.get(self.channel_id)

        if not buffer:
            logger.error(f"[{self.client_id}] No buffer found for channel {self.channel_id}")
            return False

        # Client state tracking - use config for initial position
        initial_behind = ConfigHelper.initial_behind_chunks()
        current_buffer_index = buffer.index
        self.local_index = max(0, current_buffer_index - initial_behind)

        # Store important objects as instance variables
        self.buffer = buffer
        self.stream_manager = stream_manager
        self.last_yield_time = time.time()
        self.empty_reads = 0
        self.consecutive_empty = 0
        self.is_owner_worker = proxy_server.am_i_owner(self.channel_id) if hasattr(proxy_server, 'am_i_owner') else True

        logger.info(f"[{self.client_id}] Starting stream at index {self.local_index} (buffer at {buffer.index})")
        return True

    def _stream_data_generator(self):
        """Generate stream data chunks based on buffer contents."""
        # Main streaming loop
        while True:
            # Check if resources still exist
            if not self._check_resources():
                break

            # Get chunks at client's position using improved strategy
            chunks, next_index = self.buffer.get_optimized_client_data(self.local_index)

            if chunks:
                yield from self._process_chunks(chunks, next_index)
                self.local_index = next_index
                self.last_yield_time = time.time()
                self.empty_reads = 0
                self.consecutive_empty = 0
            else:
                # Handle no data condition (with possible keepalive packets)
                self.empty_reads += 1
                self.consecutive_empty += 1

                # Check if we're too far behind (chunks expired from Redis)
                chunks_behind = self.buffer.index - self.local_index
                if chunks_behind > 50:  # If more than 50 chunks behind, jump forward
                    # Calculate new position: stay a few chunks behind current buffer
                    initial_behind = ConfigHelper.initial_behind_chunks()
                    new_index = max(self.local_index, self.buffer.index - initial_behind)

                    logger.warning(f"[{self.client_id}] Client too far behind ({chunks_behind} chunks), jumping from {self.local_index} to {new_index}")
                    self.local_index = new_index
                    self.consecutive_empty = 0  # Reset since we're repositioning
                    continue  # Try again immediately with new position

                if self._should_send_keepalive(self.local_index):
                    keepalive_packet = create_ts_packet('keepalive')
                    logger.debug(f"[{self.client_id}] Sending keepalive packet while waiting at buffer head")
                    yield keepalive_packet
                    self.bytes_sent += len(keepalive_packet)
                    self.last_yield_time = time.time()
                    self.consecutive_empty = 0  # Reset consecutive counter but keep total empty_reads
                    gevent.sleep(Config.KEEPALIVE_INTERVAL)  # Replace time.sleep
                else:
                    # Standard wait with backoff
                    sleep_time = min(0.1 * self.consecutive_empty, 1.0)
                    gevent.sleep(sleep_time)  # Replace time.sleep

                # Check for ghost clients
                if self._is_ghost_client(self.local_index):
                    logger.warning(f"[{self.client_id}] Possible ghost client: buffer has advanced {self.buffer.index - self.local_index} chunks ahead but client stuck at {self.local_index}")
                    break

                # Check for timeouts
                if self._is_timeout():
                    break

    def _check_resources(self):
        """Check if required resources still exist."""
        proxy_server = ProxyServer.get_instance()

        # Enhanced resource checks
        if self.channel_id not in proxy_server.stream_buffers:
            return False

        if self.channel_id not in proxy_server.client_managers:
            return False

        # Check if this specific client has been stopped (Redis keys, etc.)
        if proxy_server.redis_client:
            # Channel stop check - with extended key set
            stop_key = RedisKeys.channel_stopping(self.channel_id)
            if proxy_server.redis_client.exists(stop_key):
                return False

            # Client stop check
            client_stop_key = RedisKeys.client_stop(self.channel_id, self.client_id)
            if proxy_server.redis_client.exists(client_stop_key):
                return False

        return True

    def _process_chunks(self, chunks, next_index):
        """Process and yield chunks to the client."""
        # Process and send chunks
        total_size = sum(len(c) for c in chunks)
        proxy_server = ProxyServer.get_instance()

        # Send the chunks to the client
        for chunk in chunks:
            try:
                yield chunk
                self.bytes_sent += len(chunk)
                self.chunks_sent += 1

                current_time = time.time()

                # Calculate average rate (since stream start)
                elapsed_total = current_time - self.stream_start_time
                avg_rate = self.bytes_sent / elapsed_total / 1024 if elapsed_total > 0 else 0

                # Calculate current rate (since last measurement)
                elapsed_current = current_time - self.last_stats_time
                bytes_since_last = self.bytes_sent - self.last_stats_bytes

                if elapsed_current > 0:
                    self.current_rate = bytes_since_last / elapsed_current / 1024

                # Update last stats values
                self.last_stats_time = current_time
                self.last_stats_bytes = self.bytes_sent

                # Store stats in Redis client metadata
                if proxy_server.redis_client:
                    try:
                        client_key = RedisKeys.client_metadata(self.channel_id, self.client_id)
                        stats = {
                            ChannelMetadataField.CHUNKS_SENT: str(self.chunks_sent),
                            ChannelMetadataField.BYTES_SENT: str(self.bytes_sent),
                            ChannelMetadataField.AVG_RATE_KBPS: str(round(avg_rate, 1)),
                            ChannelMetadataField.CURRENT_RATE_KBPS: str(round(self.current_rate, 1)),
                            ChannelMetadataField.STATS_UPDATED_AT: str(current_time)
                        }
                        proxy_server.redis_client.hset(client_key, mapping=stats)

                        # Refresh TTL periodically while actively streaming
                        if current_time - self.last_ttl_refresh > self.ttl_refresh_interval:
                            proxy_server.redis_client.expire(client_key, Config.CLIENT_RECORD_TTL)
                            client_set_key = f"ts_proxy:channel:{self.channel_id}:clients"
                            proxy_server.redis_client.expire(client_set_key, Config.CLIENT_RECORD_TTL)
                            self.last_ttl_refresh = current_time
                    except Exception:
                        pass

            except Exception as e:
                logger.error(f"[{self.client_id}] Error sending chunk to client: {e}")
                raise  # Re-raise to exit the generator

    def _should_send_keepalive(self, local_index):
        """Determine if a keepalive packet should be sent."""
        at_buffer_head = local_index >= self.buffer.index
        stream_healthy = self.stream_manager.healthy if self.stream_manager else True
        return at_buffer_head and not stream_healthy and self.consecutive_empty >= 5

    def _is_ghost_client(self, local_index):
        """Check if this appears to be a ghost client (stuck but buffer advancing)."""
        return self.consecutive_empty > 100 and self.buffer.index > local_index + 50

    def _is_timeout(self):
        """Check if the stream has timed out."""
        stream_timeout = ConfigHelper.stream_timeout()
        failover_grace_period = ConfigHelper.failover_grace_period()
        total_timeout = stream_timeout + failover_grace_period

        if time.time() - self.last_yield_time > total_timeout:
            if self.stream_manager and not self.stream_manager.healthy:
                if (hasattr(self.stream_manager, 'url_switching') and self.stream_manager.url_switching):
                    return False
                return True
            elif not self.is_owner_worker and self.consecutive_empty > 100:
                return True
        return False

    def _cleanup(self):
        """Clean up resources and report final statistics."""
        elapsed = time.time() - self.stream_start_time
        proxy_server = ProxyServer.get_instance()

        # Decrement user connection count if applicable
        if self.user_id and proxy_server.redis_client:
            user_connections_key = f"user_connections:{self.user_id}"
            try:
                current = int(proxy_server.redis_client.get(user_connections_key) or 0)
                if current > 0:
                    proxy_server.redis_client.decr(user_connections_key)
                    logger.debug(f"User {self.user_id} connection decremented (remaining: {current - 1})")
            except Exception as e:
                logger.error(f"Error decrementing user {self.user_id} connection count: {e}")

        # Release M3U profile stream allocation if this is the last client
        stream_released = False
        if proxy_server.redis_client:
            try:
                metadata_key = RedisKeys.channel_metadata(self.channel_id)
                stream_id_bytes = proxy_server.redis_client.hget(metadata_key, ChannelMetadataField.STREAM_ID)
                if stream_id_bytes:
                    if self.channel_id in proxy_server.client_managers:
                        client_count = proxy_server.client_managers[self.channel_id].get_total_client_count()
                        if client_count <= 1 and proxy_server.am_i_owner(self.channel_id):
                            from apps.channels.models import Channel
                            try:
                                channel = Channel.objects.get(uuid=self.channel_id)
                                channel.release_stream()
                                stream_released = True
                            except Exception:
                                pass
            except Exception:
                pass

        if self.channel_id in proxy_server.client_managers:
            client_manager = proxy_server.client_managers[self.channel_id]
            local_clients = client_manager.remove_client(self.client_id)
            total_clients = client_manager.get_total_client_count()
            logger.info(f"[{self.client_id}] Disconnected after {elapsed:.2f}s (local: {local_clients}, total: {total_clients})")

            # Log client disconnect event
            try:
                channel_obj = Channel.objects.get(uuid=self.channel_id)
                log_system_event(
                    'client_disconnect',
                    channel_id=self.channel_id,
                    channel_name=channel_obj.name,
                    client_ip=self.client_ip,
                    client_id=self.client_id,
                    user_agent=self.client_user_agent[:100] if self.client_user_agent else None,
                    duration=round(elapsed, 2),
                    bytes_sent=self.bytes_sent
                )
            except Exception:
                pass

            if not stream_released:
                self._schedule_channel_shutdown_if_needed(local_clients)

    def _schedule_channel_shutdown_if_needed(self, local_clients):
        """Schedule channel shutdown if there are no clients left and we're the owner."""
        proxy_server = ProxyServer.get_instance()
        if local_clients == 0 and proxy_server.am_i_owner(self.channel_id):
            def delayed_shutdown():
                shutdown_delay = ConfigHelper.channel_shutdown_delay()
                gevent.sleep(shutdown_delay)
                if self.channel_id in proxy_server.client_managers:
                    total = proxy_server.client_managers[self.channel_id].get_total_client_count()
                    if total == 0:
                        proxy_server.stop_channel(self.channel_id)
            gevent.spawn(delayed_shutdown)

def create_stream_generator(channel_id, client_id, client_ip, client_user_agent, channel_initializing=False, user_id=None):
    """
    Factory function to create a new stream generator.
    Returns a function that can be passed to StreamingHttpResponse.
    """
    generator = StreamGenerator(channel_id, client_id, client_ip, client_user_agent, channel_initializing, user_id)
    return generator.generate