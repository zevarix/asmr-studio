import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App.js';
import {initializeTheme} from './features/appearance/theme.js';
import './styles.css';
initializeTheme();
const root=document.getElementById('root');
if(!root) throw new Error('ASMR Studio root was not found');
createRoot(root).render(<StrictMode><App/></StrictMode>);
