import React from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import './responsive-nav.css';
import './theme.css';
import GeneralWorkbench from './features/general-research/GeneralWorkbench.jsx';

// This entry deliberately never imports or mounts the original domain App.
createRoot(document.getElementById('root')).render(<GeneralWorkbench/>);
