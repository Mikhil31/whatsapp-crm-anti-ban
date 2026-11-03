import './contacts.css';

/** What shows while Contacts is being read: the heading and seven grey rows, in the table's own frame. */
export default function Loading() {
  return (
    <main className="page page-full" aria-busy="true">
      <div className="ct">
        <div className="ct-app">
          <div className="ct-headrow">
            <div><h1>Contacts</h1><p>Loading people</p></div>
          </div>
          <div className="ct-layout">
            <div className="ct-card ct-files" aria-hidden>
              {[1, 2, 3, 4].map((n) => <div className="ct-sk" key={n}><i style={{ width: '60%' }} /></div>)}
            </div>
            <div className="ct-frame" role="status" aria-label="Loading people">
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <div className="ct-sk" key={n}><i style={{ width: 18 }} /><i style={{ width: '30%' }} /><i style={{ width: '20%' }} /><i style={{ width: '25%' }} /></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
