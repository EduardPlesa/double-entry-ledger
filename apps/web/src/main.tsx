import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('no #root element: index.html and main.tsx disagree');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
