import { useState, useEffect } from 'react';
import { subscribeOperationsSSE, getOperations } from '../api.js';

export function useOperations(collectionId = null) {
  const [operations, setOperations] = useState([]);

  useEffect(() => {
    // Initial fetch
    getOperations(collectionId).then(setOperations).catch(() => {});

    const es = subscribeOperationsSSE({
      onSnapshot: (ops) => {
        const filtered = collectionId ? ops.filter(o => o.collection_id === collectionId) : ops;
        setOperations(filtered);
      },
      onNew: (op) => {
        if (collectionId && op.collection_id !== collectionId) return;
        setOperations(prev => {
          const exists = prev.some(o => o.id === op.id);
          if (exists) return prev.map(o => o.id === op.id ? op : o);
          return [op, ...prev];
        });
      },
      onUpdate: (op) => {
        if (collectionId && op.collection_id !== collectionId) return;
        setOperations(prev => prev.map(o => o.id === op.id ? op : o));
      },
      onRemoved: (id) => {
        setOperations(prev => prev.filter(o => o.id !== id));
      },
    });

    // Poll fallback every 3 seconds to catch any missed SSE updates
    const poll = setInterval(() => {
      getOperations(collectionId).then(ops => {
        setOperations(prev => {
          // Merge: keep local state but update from server
          const serverMap = new Map(ops.map(o => [o.id, o]));
          const merged = prev.map(o => serverMap.get(o.id) || o);
          // Add any new server operations not in local state
          for (const o of ops) {
            if (!merged.some(m => m.id === o.id)) merged.push(o);
          }
          return merged;
        });
      }).catch(() => {});
    }, 3000);

    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [collectionId]);

  return operations;
}
