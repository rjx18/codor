// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientStore } from './store.js';
import { reconnectGraceUntil } from './connection-state.js';
import { useGraceDeadline } from './use-connection-state.js';

afterEach(()=>{vi.useRealTimers(); delete window.__CODOR_RECOVERY_GRACE_MS;});
describe('source-owned reconnect grace',()=>{
  it('retains one loss timestamp through repeated failures and another computer',()=>{
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const a=createClientStore(), b=createClientStore();
    expect(reconnectGraceUntil(a.getState())).toBeUndefined();
    a.getState().setConnected(true); a.getState().markRoomLive('eng');
    a.getState().setConnected(false);
    expect(a.getState().connected).toBe(false);
    expect(reconnectGraceUntil(a.getState())).toBe(15000);
    vi.advanceTimersByTime(2000); a.getState().setConnected(false);
    expect(reconnectGraceUntil(a.getState())).toBe(15000);
    expect(reconnectGraceUntil(b.getState())).toBeUndefined();
    b.getState().setConnected(true);b.getState().markRoomLive('eng');b.getState().setConnected(false);
    expect(reconnectGraceUntil(b.getState())).toBe(17000);
    a.getState().setConnected(false,false);
    expect(reconnectGraceUntil(a.getState())).toBeUndefined();
    b.getState().setAuthRefused(true);
    expect(reconnectGraceUntil(b.getState())).toBeUndefined();
  });
  it('expires at five seconds and a remount does not restart the deadline',async()=>{
    vi.useFakeTimers();vi.setSystemTime(10000);
    const host=document.createElement('div');document.body.append(host);
    const View=({deadline}:{deadline:number})=><span>{useGraceDeadline(deadline)?'grace':'expired'}</span>;
    let root=createRoot(host);
    try {
      await act(async()=>root.render(<View deadline={15000}/>));
      await act(async()=>vi.advanceTimersByTime(4000));
      await act(async()=>root.unmount()); root=createRoot(host);
      await act(async()=>root.render(<View deadline={15000}/>));
      await act(async()=>vi.advanceTimersByTime(999));expect(host.textContent).toBe('grace');
      await act(async()=>vi.advanceTimersByTime(1));expect(host.textContent).toBe('expired');
    }finally{await act(async()=>root.unmount());host.remove();}
    expect(vi.getTimerCount()).toBe(0);
  });
});
