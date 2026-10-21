import * as React from "react";
import i18n from "~/i18n";

import api from "~/services/api";
import { onAppEvent } from "~/services/app-events";
import { mergeConversationList, refreshConversationList, sortConversationList } from "~/lib/conversation-list-ops";
import {
  onConversationSummaryChange,
  type ConversationSummaryUpdate,
} from "~/stores/conversation-stream";
import type { ConversationListDto, PagedResult } from "~/types";

// ===== 会话列表缓存(专题1 A 族闪动修复) =====
// 与会话详情缓存(stores/conversation-store.ts 的 entries)同思路:stale-while-revalidate。
// 挂载/换助手时先画上次已知列表(不进加载态),网络返回后静默校正 —— 消灭两类闪动:
// ① 启动时"空列表→闪→加载出来"(以及 settings 快照到达触发 assistantChanged 的二次清空);
// ② 设置页返回时路由整棵重挂,列表 state 清零重取("左侧边栏闪一下")。
// 另持久化一份 localStorage 镜像(仅最后使用的助手、截断到首页规模)供冷启动播种;
// 镜像是只读缓存,权威永远是服务端,删除/改名等陈旧残留由挂载后的静默刷新在毫秒级校正。
interface ListCacheEntry {
  items: ConversationListDto[];
  hasMore: boolean;
  nextOffset: number | null;
}

const LIST_MIRROR_KEY = "rikkahub.conversation-list.mirror.v1";
const LIST_MIRROR_MAX_ITEMS = 50;

const listCache = new Map<string, ListCacheEntry>();

const keyOf = (assistantId: string | null) => assistantId ?? "";

function readListCache(assistantId: string | null): ListCacheEntry | undefined {
  return listCache.get(keyOf(assistantId));
}

/** 写穿透:items 必给;分页字段可省(沿用该助手上次的完整写入,供流式摘要更新等场景)。 */
function rememberList(
  assistantId: string | null,
  items: ConversationListDto[],
  pagination?: { hasMore: boolean; nextOffset: number | null },
): void {
  const key = keyOf(assistantId);
  const previous = listCache.get(key);
  const entry: ListCacheEntry = {
    items,
    hasMore: pagination ? pagination.hasMore : (previous?.hasMore ?? false),
    nextOffset: pagination ? pagination.nextOffset : (previous?.nextOffset ?? null),
  };
  listCache.set(key, entry);
  persistListMirror(assistantId, entry);
}

function persistListMirror(assistantId: string | null, entry: ListCacheEntry): void {
  if (typeof localStorage === "undefined") return;
  try {
    // 截断到首页规模:分页游标随截断收敛(offset 分页,从截断处续拉语义连贯);
    // 实际上挂载后的静默刷新会先于任何 loadMore 到达,截断只影响极端首帧。
    const truncated = entry.items.length > LIST_MIRROR_MAX_ITEMS;
    localStorage.setItem(
      LIST_MIRROR_KEY,
      JSON.stringify({
        assistantId,
        items: truncated ? entry.items.slice(0, LIST_MIRROR_MAX_ITEMS) : entry.items,
        hasMore: truncated ? true : entry.hasMore,
        nextOffset: truncated ? LIST_MIRROR_MAX_ITEMS : entry.nextOffset,
      }),
    );
  } catch {
    // 配额/隐私模式:镜像是尽力而为的缓存,失败静默(仅退化为旧行为)。
  }
}

// 模块加载即把 localStorage 镜像灌进内存缓存:冷启动首帧与会话内重挂走同一条读取路径。
(function hydrateListCacheFromMirror() {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(LIST_MIRROR_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    const mirror = parsed as {
      assistantId?: string | null;
      items?: ConversationListDto[];
      hasMore?: boolean;
      nextOffset?: number | null;
    };
    if (!Array.isArray(mirror.items) || mirror.items.length === 0) return;
    listCache.set(keyOf(mirror.assistantId ?? null), {
      items: mirror.items,
      hasMore: mirror.hasMore === true,
      nextOffset: typeof mirror.nextOffset === "number" ? mirror.nextOffset : null,
    });
  } catch {
    // 损坏的镜像直接忽略,等首次成功加载重建。
  }
})();

export interface UseConversationListOptions {
  currentAssistantId: string | null;
  routeId?: string | null;
  autoSelectFirst?: boolean;
  pageSize?: number;
  maxRefreshLimit?: number;
}

export interface UseConversationListResult {
  conversations: ConversationListDto[];
  activeId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refreshList: () => void;
}

export function useConversationList({
  currentAssistantId,
  routeId = null,
  autoSelectFirst = true,
  pageSize = 30,
  maxRefreshLimit = 100,
}: UseConversationListOptions): UseConversationListResult {
  // A 族修复:挂载即用缓存播种(上次已知列表)。命中则首帧就是完整列表、不进加载态;
  // 挂载后的取数效果器照常发请求,返回后静默校正(stale-while-revalidate)。
  const [conversations, setConversations] = React.useState<ConversationListDto[]>(
    () => readListCache(currentAssistantId)?.items ?? [],
  );
  const [activeId, setActiveId] = React.useState<string | null>(() => {
    if (routeId) return routeId;
    if (!autoSelectFirst) return null;
    // 与取数成功后的 autoSelectFirst 同语义:首帧就选中缓存列表的第一条,
    // 避免"列表已画出、选中态/详情却等网络"的割裂帧。
    return readListCache(currentAssistantId)?.items[0]?.id ?? null;
  });
  const [loading, setLoading] = React.useState(
    () => (readListCache(currentAssistantId)?.items.length ?? 0) === 0,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(
    () => readListCache(currentAssistantId)?.hasMore ?? false,
  );
  const [refreshToken, setRefreshToken] = React.useState(0);
  const nextOffsetRef = React.useRef<number | null>(
    readListCache(currentAssistantId)?.nextOffset ?? 0,
  );
  const currentAssistantIdRef = React.useRef<string | null>(currentAssistantId);
  const conversationsRef = React.useRef<ConversationListDto[]>([]);
  // 初值即当前助手:配合缓存播种,首挂载不再走"assistantChanged 清空重取"分支
  // (旧行为下 settings 快照到达把 null→真实 id 也会清空已加载列表 —— 启动第二次闪动)。
  const previousAssistantIdRef = React.useRef<string | null>(currentAssistantId);
  const refreshTimerRef = React.useRef<number | null>(null);
  const listRequestEpochRef = React.useRef(0);
  const loadMoreInFlightRef = React.useRef(false);

  // FE-P1-3:排序/合并/刷新纯逻辑迁至 lib/conversation-list-ops.ts(可单测),
  // 这里保留 useCallback 包装以维持既有调用点与依赖数组形状不变。
  const sortConversations = React.useCallback(
    (items: ConversationListDto[]) => sortConversationList(items),
    [],
  );

  const mergeConversations = React.useCallback(
    (base: ConversationListDto[], incoming: ConversationListDto[]) => mergeConversationList(base, incoming),
    [],
  );

  const refreshConversations = React.useCallback(
    (previous: ConversationListDto[], incoming: ConversationListDto[], replaceCount: number) =>
      refreshConversationList(previous, incoming, replaceCount),
    [],
  );

  const refreshList = React.useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  const scheduleListRefresh = React.useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      refreshList();
    }, 250);
  }, [refreshList]);

  const updateConversationSummary = React.useCallback(
    (update: ConversationSummaryUpdate) => {
      setConversations((prev) => {
        const next = sortConversations(
          prev.map((item) =>
            item.id === update.id
              ? {
                  ...item,
                  title: update.title,
                  isPinned: update.isPinned,
                  createAt: update.createAt,
                  updateAt: update.updateAt,
                  isGenerating: update.isGenerating,
                }
              : item,
          ),
        );
        // updater 内写缓存:幂等,StrictMode 双调无害。
        rememberList(currentAssistantIdRef.current, next);
        return next;
      });
    },
    [sortConversations],
  );

  React.useEffect(() => {
    currentAssistantIdRef.current = currentAssistantId;
  }, [currentAssistantId]);

  React.useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  React.useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  React.useEffect(
    // 列表失效走单一 /api/events 通道(连接预算纪律,见 services/app-events.ts)
    () =>
      onAppEvent("invalidate", (data) => {
        if (data.assistantId !== currentAssistantIdRef.current) return;
        scheduleListRefresh();
      }),
    [scheduleListRefresh],
  );

  React.useEffect(
    // 元数据桥(专题1 D 族):会话详情流的摘要变化(开始/结束生成、标题打字机、置顶)
    // 由 conversation-stream 按展示字段闸门过滤后推来 —— 纯内容增量不会到达这里,
    // 流式期间列表不再以 30Hz 重建重排。
    () => onConversationSummaryChange(updateConversationSummary),
    [updateConversationSummary],
  );

  React.useEffect(() => {
    let active = true;
    const assistantChanged = previousAssistantIdRef.current !== currentAssistantId;
    previousAssistantIdRef.current = currentAssistantId;

    // A 族修复:换助手时先试缓存 —— 命中则立即画上次已知列表(不进加载态),
    // 本次请求降级为静默校正;未命中才走清空+加载态(原行为)。
    if (assistantChanged) {
      const cached = readListCache(currentAssistantId);
      if (cached && cached.items.length > 0) {
        setConversations(cached.items);
        // 直写 ref:下方 loadedCount 需在同一趟 effect 里读到播种结果
        // (state 同步 effect 要等下一次提交才更新 ref)。
        conversationsRef.current = cached.items;
        nextOffsetRef.current = cached.nextOffset;
        setHasMore(cached.hasMore);
        setLoading(false);
      } else {
        setConversations([]);
        conversationsRef.current = [];
        nextOffsetRef.current = 0;
        setHasMore(false);
      }
    }

    const loadedCount = conversationsRef.current.length;
    const limit = Math.min(Math.max(pageSize, loadedCount), maxRefreshLimit);
    const requestEpoch = ++listRequestEpochRef.current;

    if (loadedCount === 0) {
      setLoading(true);
    }

    setError(null);

    api
      .get<PagedResult<ConversationListDto>>("conversations/paged", {
        searchParams: { offset: 0, limit },
      })
      .then((data) => {
        if (!active || requestEpoch !== listRequestEpochRef.current) return;

        // bug2 根修(1.5.0 内测):刷新游标只进不退。刷新的 limit 封顶 maxRefreshLimit,
        // 已加载超过封顶、或在途 loadMore 先落地时,服务端返回的 nextOffset 会落后于
        // 本地游标 —— 直接覆盖会让后续翻页拉回整页重复项。hasMore=false 仍无条件收敛
        // 为 null(总量收缩场景以服务端为准);游标曾到底(null)而服务端说还有更多
        // (封顶刷新看不到已加载的尾部)时,从已加载条数续探,由下一页响应自然收敛。
        const cursor = !data.hasMore
          ? null
          : Math.max(data.nextOffset ?? 0, nextOffsetRef.current ?? conversationsRef.current.length);
        const pagination = { hasMore: data.hasMore, nextOffset: cursor };
        if (loadedCount === 0) {
          const sorted = sortConversations(data.items);
          rememberList(currentAssistantId, sorted, pagination);
          setConversations(sorted);
        } else {
          setConversations((prev) => {
            const next = refreshConversations(prev, data.items, limit);
            rememberList(currentAssistantId, next, pagination);
            return next;
          });
        }
        nextOffsetRef.current = cursor;
        setHasMore(data.hasMore);

        if (routeId) {
          setActiveId(routeId);
          return;
        }

        setActiveId((current) => {
          if (current && data.items.some((item) => item.id === current)) {
            return current;
          }
          return autoSelectFirst ? (data.items[0]?.id ?? null) : null;
        });
      })
      .catch((err: Error) => {
        if (!active || requestEpoch !== listRequestEpochRef.current) return;
        setError(err.message || i18n.t("common:errors.load_conversations_failed"));
      })
      .finally(() => {
        if (!active || requestEpoch !== listRequestEpochRef.current) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    autoSelectFirst,
    currentAssistantId,
    maxRefreshLimit,
    pageSize,
    refreshConversations,
    refreshToken,
    routeId,
    sortConversations,
  ]);

  const loadMore = React.useCallback(() => {
    const offset = nextOffsetRef.current;
    // 在途去重:滚动检测层(infinite-scroll-area)会在滚动/数据变化时反复调用,
    // 去重统一收敛在数据层这一处,调用方无需自带状态。
    if (offset === null || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;

    const requestEpoch = listRequestEpochRef.current;

    api
      .get<PagedResult<ConversationListDto>>("conversations/paged", {
        searchParams: { offset, limit: pageSize },
      })
      .then((data) => {
        // 与并发刷新竞态:刷新已重置游标,本响应作废。在途标记随 finally 释放,
        // 下一次滚动检测按刷新后的游标重试(bug2 根修:旧无限滚动库在"next() 被调
        // 但列表长度没变"后永久锁死,这里的每一条丢弃/失败路径都必须可重试)。
        if (requestEpoch !== listRequestEpochRef.current) return;

        const pagination = { hasMore: data.hasMore, nextOffset: data.nextOffset ?? null };
        setConversations((prev) => {
          const next = mergeConversations(prev, data.items);
          rememberList(currentAssistantIdRef.current, next, pagination);
          return next;
        });
        nextOffsetRef.current = data.nextOffset ?? null;
        setHasMore(data.hasMore);
      })
      .catch(() => {
        // bug2 根修:瞬时失败不再 setHasMore(false)——那会把更早的历史会话整段藏起来
        // (症状即"某日期之前的会话消失")。游标与 hasMore 原样保留,下次滚动自然重试。
      })
      .finally(() => {
        loadMoreInFlightRef.current = false;
      });
  }, [mergeConversations, pageSize]);

  React.useEffect(() => {
    if (!routeId) return;
    setActiveId(routeId);
  }, [routeId]);

  React.useEffect(() => {
    if (routeId || autoSelectFirst) return;
    setActiveId(null);
  }, [autoSelectFirst, routeId]);

  return {
    conversations,
    activeId,
    setActiveId,
    loading,
    error,
    hasMore,
    loadMore,
    refreshList,
  };
}
