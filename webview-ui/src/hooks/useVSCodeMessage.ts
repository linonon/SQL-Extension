import { useEffect } from 'react';
import type { ExtensionMessage } from '../types/messages';

export function useVSCodeMessage(handler: (message: ExtensionMessage) => void): void {
  useEffect(() => {
    const listener = (event: MessageEvent<ExtensionMessage>) => {
      handler(event.data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [handler]);
}
