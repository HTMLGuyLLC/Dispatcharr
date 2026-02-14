import Dexie from 'dexie';

export const db = new Dexie('DispatcharrDB');
db.version(3).stores({
    streams: 'id, name, channel_group, m3u_account, xtream_account', // Cleaned up indices
});

export const syncStreamsToLocalDb = async (streams) => {
    try {
        // IndexedDB cannot index 'null'. Map to -1 for Uncategorized.
        const sanitized = streams.map(s => ({
            ...s,
            channel_group: s.channel_group === null ? -1 : s.channel_group
        }));
        await db.streams.bulkPut(sanitized);
        console.log(`[LocalDB] Synced ${streams.length} streams to local DB`);
    } catch (error) {
        console.error('[LocalDB] Failed to sync streams to local DB:', error);
    }
};

export const clearStreamsInLocalDb = async () => {
    try {
        await db.streams.clear();
    } catch (error) {
        console.error('Failed to clear local DB:', error);
    }
}

export const queryLocalStreams = async ({ search = '', source = null, channelGroupsMap = {} }) => {
    let collection = db.streams.toCollection();

    if (source) {
        const sourceStr = String(source);
        collection = collection.filter(item => {
            const itemM3u = item.m3u_account ? String(item.m3u_account) : null;
            const itemXtream = item.xtream_account ? String(item.xtream_account) : null;
            return itemM3u === sourceStr || itemXtream === sourceStr;
        });
    }

    if (search) {
        const query = search.toLowerCase();
        collection = collection.filter(s => {
            if (s.name.toLowerCase().includes(query)) return true;
            const groupId = s.channel_group;
            const groupName = channelGroupsMap[groupId]?.name?.toLowerCase();
            return groupName && groupName.includes(query);
        });
    }

    const results = await collection.toArray();
    console.log(`[LocalDB] Query results: ${results.length} streams (search: "${search}", source: "${source}")`);
    return results;
};

export const getLocalGroups = async ({ search = '', source = null, limit = 50, offset = 0, channelGroupsMap = {} }) => {
    let streams = [];

    // If no search/source, we can optimize by getting group keys first
    if (!search && !source) {
        const groupIds = await db.streams.orderBy('channel_group').uniqueKeys();
        const paginatedIds = groupIds.slice(offset, offset + limit);

        const groups = [];
        for (const groupId of paginatedIds) {
            const groupStreams = await db.streams.where('channel_group').equals(groupId).toArray();
            const groupName = channelGroupsMap[groupId]?.name || (groupId === -1 ? 'Uncategorized' : `Group ${groupId}`);
            groups.push([groupName, groupStreams]);
        }

        // Sort these page results alphabetically by group name
        const sortedGroups = groups.sort(([a], [b]) => {
            if (a === 'Uncategorized') return 1;
            if (b === 'Uncategorized') return -1;
            return a.localeCompare(b);
        });

        return {
            groups: sortedGroups,
            total: groupIds.length
        };
    }

    // If search/source, we have to filter
    streams = await queryLocalStreams({ search, source, channelGroupsMap });

    const groupsMap = new Map();
    for (const stream of streams) {
        const groupId = stream.channel_group;
        const groupName = channelGroupsMap[groupId]?.name || (groupId === -1 ? 'Uncategorized' : `Group ${groupId}`);
        if (!groupsMap.has(groupName)) {
            groupsMap.set(groupName, []);
        }
        groupsMap.get(groupName).push(stream);
    }

    const sortedGroups = Array.from(groupsMap.entries()).sort(([a], [b]) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return a.localeCompare(b);
    });

    return {
        groups: sortedGroups.slice(offset, offset + limit),
        total: sortedGroups.length
    };
}

export default db;
