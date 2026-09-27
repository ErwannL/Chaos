/** Lazily loaded: its JS chunk is what browser_missing_chunk blocks. */
export default function StatusPanel({ status }) {
  if (!status) return null;
  return (
    <section className="card">
      <h2>État du service : {status.status}</h2>
      <ul>
        {Object.entries(status.components).map(([name, c]) => (
          <li key={name}>
            {name} : {c.status}
          </li>
        ))}
      </ul>
    </section>
  );
}
