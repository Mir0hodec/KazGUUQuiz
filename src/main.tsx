import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import Play from './pages/Play';
import Admin from './pages/Admin';
import Display from './pages/Display';

if (location.pathname.replace(/\/+$/, '') === '/host') history.replaceState(null, '', '/admin' + location.search + location.hash);
const path = location.pathname.replace(/\/+$/, '');
const Page = path.startsWith('/admin') ? Admin : path.startsWith('/display') ? Display : Play;
createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>);
