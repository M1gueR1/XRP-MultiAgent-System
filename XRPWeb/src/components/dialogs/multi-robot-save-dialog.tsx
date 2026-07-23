import { useMemo, useState } from 'react';
import AppMgr from '@/managers/appmgr';
import EditorMgr from '@/managers/editormgr';

interface MultiRobotSaveDialogProps {
    editorId: string;
    code: string;
    onClose: () => void;
}

export default function MultiRobotSaveDialog({
    editorId,
    code,
    onClose,
}: MultiRobotSaveDialogProps) {
    const session = EditorMgr.getInstance().getEditorSession(editorId);
    const configuredIds = useMemo(() => session?.multiRobotSessionIds ?? [], [session]);
    const robots = AppMgr.getInstance().getConnectedIDERobots(configuredIds);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const saveTo = async (targetIds: string[]) => {
        if (!session || targetIds.length === 0) return;
        setSaving(true);
        setError('');
        try {
            await AppMgr.getInstance().saveFileToRobots(targetIds, session.path, code);
            session.isModified = false;
            EditorMgr.getInstance().SaveToLocalStorage(session, code);
            EditorMgr.getInstance().SelectEditorTab(editorId);
            onClose();
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex min-w-80 flex-col gap-3 p-2 text-mountain-mist-800 dark:text-mountain-mist-200">
            <div>
                <h2 className="text-lg font-bold">Save multi-XRP program</h2>
                <p className="text-sm">Choose where to save <strong>{session?.name}</strong>.</p>
            </div>

            {robots.length === 0 ? (
                <p className="rounded border border-red-500 p-2 text-sm text-red-500">None of the XRP robots assigned to this tab are connected.</p>
            ) : (
                <>
                    <button
                        className="rounded bg-purple-700 px-3 py-2 font-semibold text-white disabled:opacity-50"
                        disabled={saving}
                        onClick={() => void saveTo(robots.map((robot) => robot.sessionId))}
                    >
                        Save in all connected XRPs ({robots.length})
                    </button>
                    <div className="border-t border-mountain-mist-500 pt-2">
                        <p className="mb-2 text-sm font-semibold">Or save only in one XRP:</p>
                        <div className="flex flex-wrap gap-2">
                            {robots.map((robot) => (
                                <button
                                    key={robot.sessionId}
                                    className="rounded border border-purple-500 px-3 py-2 text-sm disabled:opacity-50"
                                    disabled={saving}
                                    onClick={() => void saveTo([robot.sessionId])}
                                >
                                    {robot.alias} ({robot.transport})
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}

            {configuredIds.length > robots.length && (
                <p className="text-xs text-yellow-600 dark:text-yellow-300">Some robots assigned to this tab are currently disconnected.</p>
            )}
            {error && <p className="rounded border border-red-500 p-2 text-sm text-red-500">{error}</p>}

            <button className="self-end rounded border px-3 py-1" disabled={saving} onClick={onClose}>Cancel</button>
        </div>
    );
}
