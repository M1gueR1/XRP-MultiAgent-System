import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EditorMgr, { EditorSession } from '@/managers/editormgr';
import { EditorType } from '@/utils/types';
import { Model } from 'flexlayout-react';
import { StorageKeys } from '@/utils/localstorage';
import AppMgr, { EventType } from '@/managers/appmgr';
import { CommandToXRPMgr } from '@/managers/commandstoxrpmgr';

describe('EditorMgr', () => {
    afterEach(() => vi.restoreAllMocks());
    let editorMgr: EditorMgr;
    let session: EditorSession;

    beforeEach(() => {
        editorMgr = EditorMgr.getInstance();
        session = {
            id: '1',
            name: 'Test Session',
            path: '/path/to/file',
            type: EditorType.PYTHON,
            isSubscribed: false,
            fontsize: 14,
            content: 'print("Hello, World!")',
            lastUpdated: undefined,
            isModified: false,
        };
    });

    it('keeps a rejected Bluetooth draft locally and shows an error before opening saving progress', async () => {
        const emit = vi.fn();
        const connection = { isConnected: () => true, assertFileUploadSafe: () => { throw new Error('reserved restart marker'); } };
        vi.spyOn(AppMgr, 'getInstance').mockReturnValue({
            getConnection: () => connection, authService: { isLogin: false }, emit,
        } as unknown as AppMgr);
        const upload = vi.spyOn(CommandToXRPMgr.prototype, 'uploadFile');
        const manager = new EditorMgr();
        manager.AddEditor(session);
        const draft = '# ##XRP' + 'STOP##\nprint(1)';
        await manager.saveEditor(session.id, draft);
        expect(upload).not.toHaveBeenCalled();
        expect(session.isModified).toBe(true);
        expect(session.content).toBe(draft);
        expect(emit).toHaveBeenCalledWith(EventType.EVENT_ALERT, 'reserved restart marker');
        expect(emit).not.toHaveBeenCalledWith(EventType.EVENT_SHOWPROGRESS, expect.anything());
        const saved = JSON.parse(localStorage.getItem(StorageKeys.EDITORSTORE) ?? '[]');
        expect(saved.find((item: { id: string }) => item.id === session.id)).toMatchObject({ content: draft, isSavedToXRP: false });
    });

    it('should add a new editor session', () => {
        editorMgr.AddEditor(session);
        expect(editorMgr.getEditorSession(session.id)).toEqual(session);
    });

    it('should not add a duplicate editor session', () => {
        editorMgr.AddEditor(session);
        editorMgr.AddEditor(session);
        expect(editorMgr.getEditorSession(session.id)).toEqual(session);
    });

    it('should remove an editor session', () => {
        editorMgr.AddEditor(session);
        editorMgr.RemoveEditor(session.id);
        expect(editorMgr.getEditorSession(session.id)).toBeUndefined();
    });

    it('should set and get the layout model', () => {
        const model = new Model();
        editorMgr.setLayoutModel(model);
        expect(editorMgr.getLayoutModel()).toBe(model);
    });

    it('should check if an editor session exists', () => {
        editorMgr.AddEditor(session);
        expect(editorMgr.hasEditorSession(session.id)).toBe(true);
        expect(editorMgr.hasEditorSession('nonexistent')).toBe(false);
    });

    it('should check if a subscription exists', () => {
        editorMgr.AddEditor(session);
        expect(editorMgr.hasSubscription(session.id)).toBe(false);
        editorMgr.setSubscription(session.id);
        expect(editorMgr.hasSubscription(session.id)).toBe(true);
    });

    it('should get and set the fontsize of an editor session', () => {
        editorMgr.AddEditor(session);
        expect(editorMgr.getFontsize(session.id)).toBe(14);
        editorMgr.setFontsize(session.id, 16);
        expect(editorMgr.getFontsize(session.id)).toBe(16);
    });

    it('persists the XRP owner of a Python tab', () => {
        const ownedSession: EditorSession = {
            ...session,
            id: 'robot-owned-editor',
            robotSessionId: 'ble-xrp-a',
        };
        editorMgr.AddEditor(ownedSession);

        editorMgr.SaveToLocalStorage(ownedSession, ownedSession.content ?? '');

        const stores = JSON.parse(localStorage.getItem(StorageKeys.EDITORSTORE) ?? '[]') as Array<{
            id: string;
            robotSessionId?: string | null;
        }>;
        expect(stores.find((store) => store.id === ownedSession.id)?.robotSessionId).toBe('ble-xrp-a');
    });
});
