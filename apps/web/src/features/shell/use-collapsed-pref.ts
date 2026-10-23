'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { collapsedFromStorage, collapsedToStorage } from './collapse';

function readCollapsed(key: string): boolean {
  try {
    return collapsedFromStorage(window.localStorage.getItem(key));
  } catch {
    return false;
  }
}

/**
 * 只记在本机 localStorage。服务端快照固定为展开，避免水合不一致。
 * 同一标签页写入后派发 storage 事件，让订阅者重新读取。
 */
export function useCollapsedPref(key: string): readonly [boolean, (collapsed: boolean) => void] {
  const subscribe = useCallback((onChange: () => void) => {
    const handler = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      onChange();
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [key]);

  const getSnapshot = useCallback(() => readCollapsed(key), [key]);
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, () => false);

  const setCollapsed = useCallback(
    (next: boolean) => {
      try {
        window.localStorage.setItem(key, collapsedToStorage(next));
      } catch {
        return;
      }
      window.dispatchEvent(new StorageEvent('storage', { key }));
    },
    [key],
  );

  return [collapsed, setCollapsed] as const;
}
