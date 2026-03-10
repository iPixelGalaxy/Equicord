/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { ActiveJoinedThreadsStore, ChannelStore, Menu, React, SelectedChannelStore, useStateFromStores } from "@webpack/common";

import { BetterForumsStore, DEFAULT_PREFS } from "./ThreadStore";

const NumberBadge = findComponentByCodeLazy("BADGE_NOTIFICATION_BACKGROUND", "let{count:");

// ChannelFlags.PINNED = 1 << 1
const PINNED_FLAG = 1 << 1;

const tagFilterCache = new Map<string, string[]>();

type ThreadChannel = Channel & { appliedTags?: string[]; };

const settings = definePluginSettings({
    showOpenThreadCount: {
        type: OptionType.BOOLEAN,
        description: "Show open thread count badge on forum channels in the sidebar",
        default: true,
    }
});

export default definePlugin({
    name: "BetterForums",
    description: "Adds per-channel sort order (ascending/descending), hide closed threads filter, hide selected tags filter, and open thread count badges to Discord forum channels",
    authors: [EquicordDevs.iPixelGalaxy],
    settings,

    patches: [
        {
            find: "forum-grid-header-section-",
            replacement: [
                // Intercept activeThreadIds (g) and archivedThreadIds (f) in the forum channel
                // list component right before Discord derives hasActiveThreads (V) and hasAnyThread (W).
                // The }($1) captures the channel variable from the IIFE call that precedes V/W.
                // Using the comma operator inside V's initializer we:
                //   1. Call useForumPrefs() as a React hook so the component re-renders on pref changes
                //   2. Reassign g in-place with applySort  (reverses for ascending order, filters tagged)
                //   3. Reassign f in-place with applyFilter (hides closed / tagged when active)
                // Both eG (section counts) and ez (section data) are computed after this point,
                // so they naturally pick up the modified arrays.
                {
                    match: /\}\((\i)\),(\i)=(\i)\.length>0,(\i)=\2\|\|(\i)\.length>0/,
                    replace: "}($1),$2=($self.useForumPrefs(),$3=$self.applySort($3,$1.id),$5=$self.applyFilter($5,$1.id),$3.length>0),$4=$2||$5.length>0"
                },
                // Capture the active tag filter via a side-effect declarator after Discord computes it.
                // tagSetting may be absent and the IIFE wrapper is optional in some Discord builds.
                {
                    match: /(\{tagFilter:(\i)[^}]*\}=(?:\(0,)?\i\.\i\)?\((\i)\.id\))/,
                    replace: "$1,_bfTagCache=($self.cacheTagFilter($2,$3.id),null)"
                }
            ]
        },
        // Sidebar open thread count badge
        {
            find: "UNREAD_IMPORTANT:",
            replacement: {
                match: /\.Children\.count.+?:null(?<=,channel:(\i).+?)/,
                replace: "$&,$self.ForumBadge({channel: $1})"
            }
        }
    ],

    contextMenus: {
        "sort-and-view": (children, props) => {
            const channelId: string = props?.channel?.id ?? props?.channelId;
            if (!channelId) return;
            const channel = ChannelStore.getChannel(channelId);
            if (!channel?.isForumChannel()) return;

            const prefs = BetterForumsStore.getPrefs(channelId);

            // Wrap Discord's "Reset to default" action to also reset our prefs
            const resetIdx = children.findIndex(child =>
                [child?.props?.children].flat(2).some((c: any) => c?.props?.id === "reset-all")
            );
            if (resetIdx !== -1) {
                const resetGroup = children[resetIdx];
                const resetItem = [resetGroup.props.children].flat().find((c: any) => c?.props?.id === "reset-all");
                if (resetItem) {
                    const origAction = resetItem.props.action;
                    children[resetIdx] = React.cloneElement(resetGroup, {
                        children: React.cloneElement(resetItem, {
                            action: () => {
                                origAction?.();
                                BetterForumsStore.setPrefs(channelId, DEFAULT_PREFS);
                            }
                        })
                    });
                }
            }

            const items = [
                <Menu.MenuGroup label="Order" key="bf-order-group">
                    <Menu.MenuRadioItem
                        id="bf-order-desc"
                        group="bf-order"
                        label="Descending"
                        checked={prefs.order === "desc"}
                        action={() => BetterForumsStore.setPrefs(channelId, { order: "desc" })}
                    />
                    <Menu.MenuRadioItem
                        id="bf-order-asc"
                        group="bf-order"
                        label="Ascending"
                        checked={prefs.order === "asc"}
                        action={() => BetterForumsStore.setPrefs(channelId, { order: "asc" })}
                    />
                </Menu.MenuGroup>,
                <Menu.MenuSeparator key="bf-sep" />,
                <Menu.MenuGroup key="bf-hide-group">
                    <Menu.MenuCheckboxItem
                        id="bf-hide-closed"
                        label="Hide Closed"
                        checked={prefs.hideClosed}
                        action={() => BetterForumsStore.setPrefs(channelId, { hideClosed: !prefs.hideClosed })}
                    />
                    <Menu.MenuCheckboxItem
                        id="bf-hide-tagged"
                        label="Hide Selected Tags"
                        checked={prefs.hideTagged}
                        action={() => BetterForumsStore.setPrefs(channelId, { hideTagged: !prefs.hideTagged })}
                    />
                </Menu.MenuGroup>,
                <Menu.MenuSeparator key="bf-sep2" />
            ];

            // Insert before "Reset to default" so it stays at the bottom
            if (resetIdx !== -1) {
                children.splice(resetIdx, 0, ...items);
            } else {
                children.push(...items);
            }
        }
    },

    // Subscribed to BetterForumsStore; return value is discarded — the hook's
    // side-effect of subscribing the component is what triggers re-renders.
    useForumPrefs() {
        return useStateFromStores([BetterForumsStore], () => {
            const channelId = SelectedChannelStore.getChannelId();
            return channelId ? BetterForumsStore.getPrefs(channelId) : null;
        });
    },

    // Stores the active tag filter for a channel. If the filter changed, schedules
    // a re-render via BetterForumsStore so applySort/applyFilter pick up the new value.
    // (The cache is written AFTER applySort/applyFilter run each render, so without the
    // re-render trigger there would be a 1-frame lag when the tag filter changes.)
    cacheTagFilter(tagFilter: any, channelId: string) {
        // Discord's tagFilter may be a Set, array, or other iterable — normalise to string[]
        let incoming: string[];
        if (!tagFilter) incoming = [];
        else if (Array.isArray(tagFilter)) incoming = tagFilter;
        else try { incoming = Array.from(tagFilter); } catch { incoming = []; }

        const prev = tagFilterCache.get(channelId);
        tagFilterCache.set(channelId, incoming);
        if (!prev || prev.length !== incoming.length || prev.some((t, i) => t !== incoming[i]))
            setTimeout(() => BetterForumsStore.emitChange(), 0);
    },

    // Filters and/or reverses the active thread ID array based on per-channel prefs.
    // Pinned posts are kept at the top regardless of sort direction.
    applySort(threadIds: string[], channelId: string): string[] {
        const prefs = BetterForumsStore.getPrefs(channelId);
        let result = [...threadIds];

        if (prefs.hideTagged) {
            const tagFilter = tagFilterCache.get(channelId) ?? [];
            if (tagFilter.length > 0) {
                const tagSet = new Set(tagFilter);
                result = result.filter(id => {
                    const thread = ChannelStore.getChannel(id) as ThreadChannel | null;
                    return !thread || !(thread.appliedTags ?? []).some(tag => tagSet.has(tag));
                });
            }
        }

        if (prefs.order === "asc") {
            const isPinned = (id: string) => ((ChannelStore.getChannel(id)?.flags ?? 0) & PINNED_FLAG) !== 0;
            const pinned = result.filter(isPinned);
            const unpinned = result.filter(id => !isPinned(id));
            return [...pinned, ...unpinned.reverse()];
        }
        return result;
    },

    // Filters the archived thread ID array based on per-channel prefs.
    applyFilter(archivedThreadIds: string[], channelId: string): string[] {
        const prefs = BetterForumsStore.getPrefs(channelId);
        if (prefs.hideClosed) return [];
        if (prefs.hideTagged) {
            const tagFilter = tagFilterCache.get(channelId) ?? [];
            if (tagFilter.length > 0) {
                const tagSet = new Set(tagFilter);
                return archivedThreadIds.filter(id => {
                    const thread = ChannelStore.getChannel(id) as ThreadChannel | null;
                    return !thread || !(thread.appliedTags ?? []).some(tag => tagSet.has(tag));
                });
            }
        }
        return archivedThreadIds;
    },

    ForumBadge: ErrorBoundary.wrap(({ channel }: { channel: Channel; }) => {
        if (!channel.isForumChannel()) return null;
        if (!settings.store.showOpenThreadCount) return null;

        const openCount = useStateFromStores([ActiveJoinedThreadsStore, BetterForumsStore], () => {
            const joined = ActiveJoinedThreadsStore.getActiveJoinedThreadsForParent(channel.guild_id, channel.id);
            const unjoined = ActiveJoinedThreadsStore.getActiveUnjoinedThreadsForParent(channel.guild_id, channel.id);
            return Object.keys(joined).length + Object.keys(unjoined).length;
        });

        if (!openCount) return null;
        return <NumberBadge className="bf-forum-badge" color="var(--brand-500)" count={openCount} />;
    }, { noop: true }),
});
