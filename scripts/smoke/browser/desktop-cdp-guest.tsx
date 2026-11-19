import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
function Form() {
  const [value, setValue] = useState('old');
  const [trusted, setTrusted] = useState(false);
  const [result, setResult] = useState('Ready');
  return <><input aria-label="Name" value={value} onChange={event => setValue(event.target.value)} onInput={event => setTrusted(event.isTrusted)} />
    <input aria-label="Password" type="password" defaultValue="secret-fixture-value" />
    <button onClick={event => setResult(`Saved:${value}:${trusted && event.isTrusted ? 'trusted' : 'untrusted'}`)}>Save</button>
    <output style={{ whiteSpace: 'pre' }}>{result}</output></>;
}
createRoot(document.getElementById('root')!).render(<Form />);
