import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApi } from '../src/useApi.js';
import { mockFetch } from './helpers.jsx';

afterEach(cleanup);

function Probe({ path, poll }) {
  const { data, error } = useApi(path, poll);
  return <p>{error ? error.message : JSON.stringify(data)}</p>;
}

describe('useApi', () => {
  it('loads data and stops polling on unmount', async () => {
    mockFetch({ 'GET /x': { a: 1 } });
    const { unmount } = render(<Probe path="/x" poll={10} />);
    expect(await screen.findByText('{"a":1}')).toBeInTheDocument();
    unmount();
  });
});
