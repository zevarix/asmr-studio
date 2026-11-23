import type {Layer} from '@asmr-studio/contracts';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import IconMicrophone from '@tabler/icons-react/icons/IconMicrophone';
export function NarrationPanel({layers}:{layers:Layer[]}) {
  const narration=layers.filter(layer=>layer.role==='narration');
  return <details className="narration-panel">
    <summary><span className="summary-label"><IconMicrophone size={18} stroke={1.7} aria-hidden="true"/>Recorded narration <span className="summary-count">({narration.length} tracks)</span></span><IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/></summary>
    <p>{narration.length===0?'You can import a voice recording whenever you want narration. It stays on its own adjustable layer.':'Each recording has its own volume and stereo position in the mix. Recorded narration plays once unless you enable its loop.'}</p>
  </details>;
}
