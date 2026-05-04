import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { clearAllStoreCaches, deleteStoreCache, getStoreCacheInfo } from "@/lib/tauri/store-cache";
import { IMPLEMENT_STORE_KEY } from "@/stores/implementTicket/constants";
import { INITIAL as IMPLEMENT_INITIAL } from "@/stores/implementTicket/initial";
import { useImplementTicketStore } from "@/stores/implementTicket/store";
import { PR_REVIEW_STORE_KEY } from "@/stores/prReview/constants";
import { usePrReviewStore } from "@/stores/prReview/store";
import { CheckCircle, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

const CACHE_KEY_LABELS: Record<string, string> = {
  [IMPLEMENT_STORE_KEY]: "Implement a Ticket pipeline sessions",
  [PR_REVIEW_STORE_KEY]: "PR Review sessions",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const ALL_KEY = "__all__";

function resetInMemoryStoreFor(key: string) {
  if (key === IMPLEMENT_STORE_KEY) {
    useImplementTicketStore.setState({
      ...IMPLEMENT_INITIAL,
      sessions: new Map(),
    });
  } else if (key === PR_REVIEW_STORE_KEY) {
    usePrReviewStore.setState({
      sessions: new Map(),
      prsForReview: [],
      allOpenPrs: [],
      selectedPr: null,
      isSessionActive: false,
      prListLoaded: false,
    });
  }
}

export function CacheSection() {
  const [info, setInfo] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearingKey, setClearingKey] = useState<string | null>(null);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  async function loadInfo() {
    setLoading(true);
    try {
      const result = await getStoreCacheInfo();
      setInfo(result);
    } catch {
      /* non-critical */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInfo();
  }, []);

  const totalBytes = info ? Object.values(info).reduce((a, b) => a + b, 0) : 0;
  const hasCache = totalBytes > 0;

  async function handleClear(key: string) {
    if (confirmingKey !== key) {
      setConfirmingKey(key);
      return;
    }
    setClearingKey(key);
    try {
      if (key === ALL_KEY) {
        await clearAllStoreCaches();
        Object.keys(info ?? {}).forEach(resetInMemoryStoreFor);
        setInfo({});
        setDoneMessage("All session caches cleared.");
      } else {
        await deleteStoreCache(key);
        resetInMemoryStoreFor(key);
        setInfo((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        const label = CACHE_KEY_LABELS[key] ?? key;
        setDoneMessage(`Cleared ${label}.`);
      }
      setConfirmingKey(null);
    } catch {
      /* non-critical */
    } finally {
      setClearingKey(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Session Cache</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Pipeline and PR review sessions are saved to disk so they survive
              app restarts
            </CardDescription>
          </div>
          {hasCache && (
            <Badge
              variant="outline"
              className="gap-1 text-muted-foreground shrink-0"
            >
              {formatBytes(totalBytes)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading cache info…
          </div>
        ) : info && Object.keys(info).length > 0 ? (
          <div className="space-y-1">
            {Object.entries(info).map(([key, size]) => {
              const isConfirming = confirmingKey === key;
              const isClearing = clearingKey === key;
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 text-xs py-0.5"
                >
                  <span className="text-muted-foreground truncate">
                    {CACHE_KEY_LABELS[key] ?? key}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-muted-foreground">
                      {formatBytes(size)}
                    </span>
                    <Button
                      variant={isConfirming ? "destructive" : "ghost"}
                      size="sm"
                      onClick={() => handleClear(key)}
                      disabled={
                        isClearing || (clearingKey !== null && !isClearing)
                      }
                      className="h-7 gap-1.5 px-2"
                    >
                      {isClearing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                      {isConfirming ? "Confirm" : "Clear"}
                    </Button>
                    {isConfirming && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmingKey(null)}
                        className="h-7 px-2"
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No session cache on disk.
          </p>
        )}

        {doneMessage && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> {doneMessage}
          </p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {hasCache && (
            <Button
              variant={confirmingKey === ALL_KEY ? "destructive" : "outline"}
              size="sm"
              onClick={() => handleClear(ALL_KEY)}
              disabled={clearingKey !== null}
              className="gap-1.5"
            >
              {clearingKey === ALL_KEY ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              {confirmingKey === ALL_KEY
                ? "Click again to confirm"
                : "Clear all"}
            </Button>
          )}
          {confirmingKey === ALL_KEY && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingKey(null)}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDoneMessage(null);
              loadInfo();
            }}
            disabled={loading}
            className="text-muted-foreground"
          >
            Refresh
          </Button>
        </div>

        {confirmingKey && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {confirmingKey === ALL_KEY
              ? "This will permanently delete all saved pipeline sessions and PR review data. In-progress work will be lost."
              : `This will permanently delete the "${
                  CACHE_KEY_LABELS[confirmingKey] ?? confirmingKey
                }" cache. In-progress work in this section will be lost.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
