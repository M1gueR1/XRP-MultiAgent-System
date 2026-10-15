import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FaArrowDown, FaArrowLeft, FaArrowRight, FaArrowUp, FaBluetoothB, FaBolt, FaCheckCircle, FaSpinner, FaTimes } from 'react-icons/fa';
import xrpImage from '@assets/images/xrp-run-selector.png';

export type BluetoothGameStatus = 'connecting' | 'initializing' | 'connected' | 'error';

type Props = {
    status: BluetoothGameStatus;
    robotNames: string[];
    error?: string;
    onClose: () => void;
};

type Direction = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
const DIRECTIONS: Direction[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const BOARD_SIZE = 5;

export default function BluetoothConnectionGame({ status, robotNames, error, onClose }: Props) {
    const [game, setGame] = useState({ robot: 12, energy: 13, score: 0 });
    const [elapsed, setElapsed] = useState(0);
    const startedAt = useRef(Date.now());
    const gridRef = useRef<HTMLDivElement>(null);
    const pending = status === 'connecting' || status === 'initializing';

    useEffect(() => {
        const update = () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
        update();
        if (!pending) return;
        const timer = window.setInterval(update, 1000);
        return () => window.clearInterval(timer);
    }, [pending]);

    function move(direction: Direction) {
        const random = Math.random();
        setGame((current) => {
            const row = Math.floor(current.robot / BOARD_SIZE);
            const column = current.robot % BOARD_SIZE;
            const nextRow = Math.max(0, Math.min(4, row + (direction === 'ArrowDown' ? 1 : direction === 'ArrowUp' ? -1 : 0)));
            const nextColumn = Math.max(0, Math.min(4, column + (direction === 'ArrowRight' ? 1 : direction === 'ArrowLeft' ? -1 : 0)));
            const robot = nextRow * BOARD_SIZE + nextColumn;
            if (robot === current.robot) return current;
            if (robot !== current.energy) return { ...current, robot };
            // Pick one of the other 24 cells, never underneath the XRP.
            const candidate = Math.floor(random * (BOARD_SIZE * BOARD_SIZE - 1));
            return { robot, energy: candidate >= robot ? candidate + 1 : candidate, score: current.score + 1 };
        });
    }

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        // Keep game input away from the IDE's document-level joystick shortcuts.
        event.stopPropagation();
        if (!DIRECTIONS.includes(event.key as Direction)) return;
        event.preventDefault();
        move(event.key as Direction);
    }

    function moveFromButton(direction: Direction) {
        move(direction);
        gridRef.current?.focus();
    }

    const controls = [
        { direction: 'ArrowUp' as const, Icon: FaArrowUp, label: 'Move up', placement: 'col-start-2 row-start-1' },
        { direction: 'ArrowLeft' as const, Icon: FaArrowLeft, label: 'Move left', placement: 'col-start-1 row-start-2' },
        { direction: 'ArrowDown' as const, Icon: FaArrowDown, label: 'Move down', placement: 'col-start-2 row-start-2' },
        { direction: 'ArrowRight' as const, Icon: FaArrowRight, label: 'Move right', placement: 'col-start-3 row-start-2' },
    ];

    return (
        <section onKeyDown={handleKeyDown} onKeyUp={(event) => event.stopPropagation()} className="flex flex-col gap-4 p-4 sm:p-5">
            <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 id="bluetooth-game-title" className="flex items-center gap-2 text-lg font-semibold text-[#ffffff]">
                        <FaBluetoothB className="shrink-0 text-[#c4b5fd]" aria-hidden="true" />
                        Bluetooth connection
                    </h2>
                    {robotNames.length > 0 && <p className="mt-1 break-words text-sm text-mountain-mist-300">{robotNames.join(', ')}</p>}
                </div>
                <button type="button" onClick={onClose} title="Close window" aria-label="Close window" className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-mountain-mist-500 text-mountain-mist-200 hover:border-mountain-mist-100 hover:text-mountain-mist-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c4b5fd]">
                    <FaTimes aria-hidden="true" />
                </button>
            </header>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-lg font-semibold text-[#fde047]">
                    <FaBolt aria-hidden="true" />
                    <span>Energy: <span data-testid="energy-score">{game.score}</span></span>
                </div>
                <div className="ml-auto flex flex-col items-end gap-1 text-right text-sm">
                    <p role="status" aria-live="polite" className={`flex items-center gap-2 ${status === 'connected' ? 'text-chateau-green-300' : status === 'error' ? 'text-cinnabar-300' : 'text-mountain-mist-100'}`}>
                        {pending && <FaSpinner className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        {status === 'connected' && <FaCheckCircle className="shrink-0" aria-hidden="true" />}
                        {status === 'connected' ? 'XRP connected' : status === 'initializing' ? 'Initializing XRP...' : status === 'error' ? 'Connection needs attention' : 'Connecting Bluetooth...'}
                    </p>
                    {!pending && <button type="button" onClick={onClose} className="text-sm text-[#ffffff] underline underline-offset-4 hover:text-[#c4b5fd]">Close window</button>}
                </div>
            </div>

            <div ref={gridRef} data-energy-grid tabIndex={0} role="grid" aria-label="Energy collection grid" className="grid aspect-square w-full grid-rows-5 gap-1.5 rounded border border-mountain-mist-500 bg-mountain-mist-950 p-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c4b5fd]">
                {Array.from({ length: BOARD_SIZE }, (_, row) => (
                    <div role="row" key={row} className="grid min-h-0 grid-cols-5 gap-1.5">
                        {Array.from({ length: BOARD_SIZE }, (_, column) => {
                            const cell = row * BOARD_SIZE + column;
                            const hasRobot = game.robot === cell;
                            const hasEnergy = game.energy === cell;
                            return (
                                <div role="gridcell" key={cell} aria-label={`${hasRobot ? 'XRP' : hasEnergy ? 'Energy' : 'Empty'}, row ${row + 1}, column ${column + 1}`} className={`flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-sm border ${hasRobot ? 'border-[#c4b5fd] bg-[#3b1760]' : hasEnergy ? 'border-[#facc15]/70 bg-[#30250b]' : 'border-mountain-mist-700 bg-mountain-mist-900'}`}>
                                    {hasRobot && <img src={xrpImage} alt="XRP" draggable={false} className="h-full w-full object-contain p-1" />}
                                    {hasEnergy && <FaBolt className="h-1/2 w-1/2 text-[#fde047]" aria-hidden="true" />}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>

            <footer className="flex items-end justify-between gap-3">
                <div className="grid grid-cols-3 grid-rows-2 gap-1.5">
                    {controls.map(({ direction, Icon, label, placement }) => (
                        <button key={direction} type="button" title={label} aria-label={label} onClick={() => moveFromButton(direction)} className={`${placement} flex h-9 w-9 items-center justify-center rounded border border-mountain-mist-500 bg-mountain-mist-900 text-[#ffffff] hover:border-[#c4b5fd] hover:bg-[#3b1760] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c4b5fd]`}>
                            <Icon aria-hidden="true" />
                        </button>
                    ))}
                </div>
                <span className="text-sm tabular-nums text-mountain-mist-300">Elapsed: {elapsed}s</span>
            </footer>
            {status === 'error' && error && <p className="break-words text-sm text-cinnabar-300">{error}</p>}
        </section>
    );
}
