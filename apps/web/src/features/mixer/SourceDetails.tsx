import {useEffect, useId, useRef, type MouseEvent, type PointerEvent} from 'react';
import {createPortal} from 'react-dom';
import IconInfoCircle from '@tabler/icons-react/icons/IconInfoCircle';
import IconX from '@tabler/icons-react/icons/IconX';
import type {AssetRecord} from '@asmr-studio/contracts';

function isBackdrop(event: MouseEvent<HTMLDialogElement> | PointerEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

/** Source information stays outside the sound grid and never sends a playback command. */
export function SourceDetails({asset}: {asset: AssetRecord}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const beganOnBackdrop = useRef(false);
  const label = `Source and permission for ${asset.displayName}`;
  const source = asset.provenance.source;
  let sourceUrl: string | null = null;
  if (source) {
    try {
      const url = new URL(source);
      if (url.protocol === 'https:' || url.protocol === 'http:') sourceUrl = url.href;
    } catch { /* Attribution can be descriptive text rather than a URL. */ }
  }

  useEffect(() => {
    const element = dialog.current;
    return () => { if (element?.open) element.close(); };
  }, []);

  const close = () => { if (dialog.current?.open) dialog.current.close(); };
  const open = () => {
    const element = dialog.current;
    if (!element || element.open) return;
    beganOnBackdrop.current = false;
    element.showModal();
    closeButton.current?.focus({preventScroll: true});
  };

  return <>
    <button ref={trigger} type="button" className="source-info-button" aria-label={label}
      aria-haspopup="dialog" aria-controls={id} title="Source and permission" onClick={open}>
      <IconInfoCircle size={18} stroke={1.7} aria-hidden="true" focusable="false"/>
    </button>
    {createPortal(<dialog ref={dialog} id={id} className="source-dialog" aria-label={label}
      onKeyDown={event => {
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex="0"]'))
          .filter(element => element.getClientRects().length > 0);
        const first = items[0];
        const last = items.at(-1);
        // Native modal isolation makes the page inert; also keep Tab from leaving for browser chrome.
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault(); first.focus();
        }
      }}
      onCancel={event => {event.preventDefault(); close();}}
      onClose={() => {
        beganOnBackdrop.current = false;
        if (trigger.current?.isConnected) trigger.current.focus({preventScroll: true});
      }}
      onPointerDown={event => {beganOnBackdrop.current = isBackdrop(event);}}
      onPointerCancel={() => {beganOnBackdrop.current = false;}}
      onClick={event => {
        const dismiss = beganOnBackdrop.current && isBackdrop(event);
        beganOnBackdrop.current = false;
        if (dismiss) close();
      }}>
      <header className="source-dialog-header">
        <div><p className="source-dialog-eyebrow">Source &amp; permission</p><h2>{asset.displayName}</h2></div>
        <button ref={closeButton} type="button" tabIndex={0} className="source-dialog-close" aria-label="Close source and permission" onClick={close}>
          <IconX size={20} stroke={1.7} aria-hidden="true" focusable="false"/>
        </button>
      </header>
      <div className="source-dialog-content" tabIndex={0} role="region" aria-label="Recording source details">
        <section aria-labelledby={`${id}-source`}>
          <h3 id={`${id}-source`}>Source</h3>
          <p>{sourceUrl
            ? <a href={sourceUrl} tabIndex={0} target="_blank" rel="noopener noreferrer">{source}</a>
            : source || (asset.provenance.kind === 'original' ? 'Original recording' : 'Source not recorded')}</p>
        </section>
        <section aria-labelledby={`${id}-permission`}>
          <h3 id={`${id}-permission`}>Permission</h3>
          <p>{asset.rights.privateUse === 'permitted' ? 'Private use permitted.' : 'Private-use permission is not recorded.'}</p>
          <p>{asset.rights.redistribution === 'permitted'
            ? 'Redistribution permitted under the source terms.'
            : asset.rights.redistribution === 'forbidden'
              ? 'Redistribution is not permitted.'
              : 'Redistribution permission is not recorded.'}</p>
        </section>
      </div>
    </dialog>, document.body)}
  </>;
}
