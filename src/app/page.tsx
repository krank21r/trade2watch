export default function Home() {
  return (
    <main
      aria-label="Trade2watch — multi-asset trade setup dashboard"
      className="h-[100dvh] w-full overflow-hidden bg-[#0b0e14]"
    >
      {/*
        Trade2watch is a self-contained single-file SPA pulled from
        github.com/krank21r/trade2watch (tradewatch.html). It is served
        verbatim from /app.html (public/) so its behavior matches the
        deployed Vercel build 1:1 — same-origin iframe keeps localStorage,
        WebAudio alerts and CoinGecko polling fully functional.
      */}
      <iframe
        src="/app.html"
        title="Trade2watch — Multi-Asset Trade Setup Dashboard"
        className="h-full w-full border-0"
        allow="autoplay"
      />
    </main>
  );
}
