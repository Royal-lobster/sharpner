import { IconArrowRight as ArrowRight, IconArrowUpRight as ArrowUpRight, IconChevronDown as ChevronDown, IconDots as MoreHorizontal, IconPlus as Plus } from "@tabler/icons-react";
import "./login-showcase.css";

/** Small, finished designs on a canvas; decorative rather than a second app to interact with. */
export function LoginShowcase() {
  return (
    <div className="login-showcase">
      <div className="showcase-scene">
        <figure className="showcase-frame showcase-dashboard">
          <figcaption>Orbit <span>Overview</span></figcaption>
          <div className="showcase-dashboard-screen">
            <header className="showcase-appbar">
              <span className="showcase-orbit-mark" /><strong>orbit</strong>
              <span className="showcase-appbar-active">Overview</span><span>Reports</span><span>Audience</span>
              <span className="showcase-avatar">J</span>
            </header>
            <div className="showcase-dashboard-content">
              <div className="showcase-dashboard-heading"><div><small>Your business, at a glance</small><h3>Looking good, June.</h3></div><span className="showcase-date">This month <ChevronDown /></span></div>
              <div className="showcase-metrics">
                <div><span>Total revenue</span><strong>$24,580<small>.00</small></strong><em><ArrowUpRight />18.6% <span>vs. last month</span></em></div>
                <div><span>Active customers</span><strong>1,284</strong><em><ArrowUpRight />12.4% <span>vs. last month</span></em></div>
                <div><span>Conversion rate</span><strong>4.8<small>%</small></strong><em><ArrowUpRight />2.1% <span>vs. last month</span></em></div>
              </div>
              <div className="showcase-chart-panel">
                <div className="showcase-chart-heading"><strong>Revenue over time</strong><span><i />This month <b>···</b></span></div>
                <div className="showcase-chart-wrap">
                  <div className="showcase-chart-labels"><span>$30k</span><span>$20k</span><span>$10k</span></div>
                  <svg className="showcase-chart" viewBox="0 0 480 115" fill="none" aria-hidden="true">
                    <path d="M0 10H480M0 47H480M0 84H480" stroke="#dedfd9" strokeDasharray="3 4" />
                    <path d="M0 92 22 85 45 88 68 72 90 78 114 69 137 73 160 49 183 56 206 46 229 56 251 36 274 41 297 30 320 34 343 15 366 26 389 11 412 17 435 4 458 12 480 3V115H0Z" fill="#dfe8df" />
                    <path d="M0 92 22 85 45 88 68 72 90 78 114 69 137 73 160 49 183 56 206 46 229 56 251 36 274 41 297 30 320 34 343 15 366 26 389 11 412 17 435 4 458 12 480 3" stroke="#436655" strokeWidth="2.2" strokeLinejoin="round" />
                    <circle cx="480" cy="3" r="3" fill="#436655" />
                  </svg>
                </div>
                <div className="showcase-chart-months"><span>Jun 1</span><span>Jun 8</span><span>Jun 15</span><span>Jun 22</span><span>Jun 30</span></div>
              </div>
              <div className="showcase-recent"><strong>Recent activity</strong><MoreHorizontal /></div>
              <div className="showcase-activity"><span className="showcase-person">AL</span><span><strong>Amelia Lane</strong><small>Pro plan · Monthly</small></span><span className="showcase-paid">Paid</span><strong>$29.00</strong></div>
            </div>
          </div>
          <span className="showcase-selection-corner" />
        </figure>

        <figure className="showcase-frame showcase-mobile">
          <figcaption>Mori <span>Discover</span></figcaption>
          <div className="showcase-mobile-screen">
            <header className="showcase-mobile-top"><strong>mori<span>↗</span></strong><span className="showcase-mobile-menu"><i /><i /></span></header>
            <p className="showcase-mobile-eyebrow">A little further from ordinary</p>
            <h3>Find your<br />kind of quiet.</h3>
            <div className="showcase-landscape-wrap">
              <svg className="showcase-landscape" viewBox="0 0 200 190" aria-hidden="true">
                <rect width="200" height="190" fill="#dce8e4" />
                <circle cx="142" cy="45" r="23" fill="#f2cf8a" />
                <path d="M0 109 54 54 119 126 166 87 200 114V190H0Z" fill="#a5b9ae" />
                <path d="m0 139 61-47 50 46 89-22v74H0Z" fill="#678879" />
                <path d="M0 159c33-9 60-12 94 0 39 14 67-9 106-8v39H0Z" fill="#3c6254" />
                <path d="M105 139c-40 15-22 26-4 34 15 7 8 13-12 17h30c15-16-1-22-14-28-15-7-19-12 0-23Z" fill="#d4e1d5" />
              </svg>
              <span className="showcase-trip-pill">WEEKEND NO. 08</span>
            </div>
            <div className="showcase-trip"><div><span>THE PACIFIC NORTHWEST</span><strong>A slower kind<br />of weekend.</strong></div><span className="showcase-round-arrow"><ArrowUpRight /></span></div>
            <div className="showcase-mobile-bottom"><span>Discover</span><span>Saved</span><Plus /></div>
          </div>
        </figure>

        <figure className="showcase-frame showcase-editorial">
          <figcaption>Forme <span>Collection 01</span></figcaption>
          <div className="showcase-editorial-screen">
            <header><strong>forme.</strong><span>Objects with a little soul.</span><span>Shop <ArrowUpRight /></span></header>
            <div className="showcase-editorial-body">
              <div><span>LESS, BUT LOVELIER.</span><h3>Good things,<br />made slowly.</h3><p>Everyday objects. Anything but ordinary.</p><span className="showcase-editorial-link">Meet the collection <ArrowRight /></span></div>
              <svg className="showcase-chair" viewBox="0 0 180 200" fill="none" aria-hidden="true">
                <ellipse cx="96" cy="185" rx="63" ry="9" fill="#995d3e" opacity=".18" />
                <path d="m57 110-8 72m75-67 12 67M67 97 60 41c-1-14 66-14 67 0l4 61" stroke="#603d27" strokeWidth="8" strokeLinecap="round" />
                <path d="M58 43c0-10 59-13 69-3l-2 41c-16-8-46-8-63 1Z" fill="#b67445" />
                <path d="M52 107c10-14 69-17 83-3l1 16c-18 8-66 10-85-1Z" fill="#bd8051" />
                <path d="M52 107c14 10 67 8 83-3" stroke="#d49b6e" strokeWidth="3" />
                <path d="m66 82 2 19m55-20 2 18" stroke="#603d27" strokeWidth="6" />
                <path d="m56 44 7 38m64-40-2 39" stroke="#d49b6e" strokeWidth="2" />
              </svg>
            </div>
            <footer><span>DESIGNED TO STAY.</span><span>01 — 04</span></footer>
          </div>
        </figure>
      </div>
    </div>
  );
}
