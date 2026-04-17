export default function RunHistory({ history, onReplay }) {
  return (
    <section className="card">
      <div className="section-title-row">
        <h2>Recent Runs</h2>
      </div>
      {history.length === 0 ? (
        <p className="muted">No runs yet. Execute a query to build interview history.</p>
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <button key={item.id} type="button" className="history-item" onClick={() => onReplay(item)}>
              <p className="history-title">{item.title}</p>
              <p className="history-subtitle">{item.timestamp}</p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
