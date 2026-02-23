import { useCallback } from 'react';
import type { WebviewMessage } from '../types/messages';
import vscodeApi from '../vscode';

export function usePostMessage(): (message: WebviewMessage) => void {
  return useCallback((message: WebviewMessage) => {
    vscodeApi.postMessage(message);
  }, []);
}
