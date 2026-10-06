import { createContext, useContext } from 'react';

// 当前 panel 的连接是否只读 (宿主在 viewInit context.readOnly 里给出, App 提供).
// 组件据此隐藏或禁用写控件; 真正的拦截在宿主, 这里只是不让用户点到必然被拒的操作
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
