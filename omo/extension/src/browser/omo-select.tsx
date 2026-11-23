/**
 * world-ui — one custom select for every World Builder / build-mode panel (no native <select>).
 *
 * The option list opens INSIDE the panel flow (it pushes the content below it down), so it can never
 * sit over the panel tabs or another panel. Keyboard: Space/Enter/ArrowDown open, Arrow keys move,
 * Enter picks, Esc closes. The trigger carries the test id and `data-value` (the current value).
 * Test hook: pick an option with `[data-testid=<id>-option][data-value=<value>]`.
 */
import * as React from 'react';
import { Icon } from './icons';
import '../../src/browser/world-tokens.css'; // world-ui: the one overlay token file
import '../../src/browser/omo-select.css';

export interface OmoSelectOption { value: string; label: string; hint?: string }

export function OmoSelect(props: {
    value: string; options: readonly OmoSelectOption[]; onChange: (value: string) => void;
    testid?: string; ariaLabel?: string; disabled?: boolean; className?: string;
}): React.ReactElement {
    const { value, options, onChange } = props;
    const [open, setOpen] = React.useState(false);
    const [active, setActive] = React.useState(() => Math.max(0, options.findIndex(o => o.value === value)));
    const root = React.useRef<HTMLDivElement>(null);
    const current = options.find(o => o.value === value) ?? options[0];
    React.useEffect(() => {
        if (!open) return;
        const away = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
        document.addEventListener('pointerdown', away, true);
        return () => document.removeEventListener('pointerdown', away, true);
    }, [open]);
    React.useEffect(() => { if (open) setActive(Math.max(0, options.findIndex(o => o.value === value))); }, [open]);
    const pick = (v: string): void => { setOpen(false); if (v !== value) onChange(v); };
    const onKey = (event: React.KeyboardEvent): void => {
        event.stopPropagation();
        if (props.disabled) return;
        if (!open) { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } return; }
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const o = options[active]; if (o) pick(o.value); }
        else if (event.key === 'Tab') setOpen(false);
    };
    return <div ref={root} className={`omo-select${open ? ' is-open' : ''}${props.className ? ` ${props.className}` : ''}`} onKeyDown={onKey}>
        <button type="button" className="omo-select-trigger" data-testid={props.testid} data-value={value} aria-haspopup="listbox" aria-expanded={open}
            aria-label={props.ariaLabel} disabled={props.disabled} title={current?.label} onClick={() => setOpen(!open)}>
            <span className="omo-select-value">{current?.label ?? ''}</span>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
        {open && <ul className="omo-select-list" role="listbox" aria-label={props.ariaLabel}>
            {options.map((o, i) => <li key={o.value || '∅'} role="option" aria-selected={o.value === value}
                className={`${i === active ? 'is-active' : ''}${o.value === value ? ' is-current' : ''}`}
                data-testid={props.testid ? `${props.testid}-option` : undefined} data-value={o.value}
                onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(o.value)}>
                <span>{o.label}{o.hint && <small>{o.hint}</small>}</span>{o.value === value && <Icon name="check" size={14} />}
            </li>)}
        </ul>}
    </div>;
}
