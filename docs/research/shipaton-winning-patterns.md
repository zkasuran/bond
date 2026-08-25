# What wins RevenueCat Shipaton: patterns for Bond (Design Award + HAMM)

Research compiled 2026-08-25 for the Bond lane. Every claim below is tied to a
primary source (shipaton.com, revenuecat.com or the Devpost rules). Where a fact
could not be verified it is marked UNVERIFIED rather than guessed.

Bond is a communication / agent-native app (humans and agents in shared rooms,
threading, agent bridges, verifiable identity and message signing). The two
target categories are the RevenueCat Design Award (product craft, polish,
animation) and HAMM (smartest use of RevenueCat to drive revenue). This document
first explains how judging actually works, because the mechanics shape every
other decision, then gives a concrete checklist.

## Shipaton 2026 at a glance

- Ship window: the app's first version must launch to the App Store, Google Play,
  or the Samsung Galaxy Store between August 1 and September 30, 2026. Building
  before August 1 is fine, the release must land inside the window.
  Source: https://www.revenuecat.com/blog/company/announcing-shipaton-2026/
- Requirement: use the RevenueCat SDK for at least one in-app purchase or serve
  ads through RevenueCat Ads. Source: announcing-shipaton-2026 (above) and the
  2025 rules https://revenuecat-shipaton-2025.devpost.com/rules
- Prize pool: over $1 million in prizes, over $700,000 of it cash, plus Times
  Square billboards, flights to the Shippies ceremony in NYC and press on
  9to5Mac and 9to5Google. Source: announcing-shipaton-2026.
- 21 categories in 2026 (7 core, 5 influencer, 7 sponsored). Named core awards
  include Grand Prize (Build & Grow), RevenueCat Design Award, HAMM, Peace Prize,
  Best Game, #BuildInPublic, Next Gen. Source: https://www.shipaton.com/
- HAMM prizes (per the category page, which says to confirm exact numbers on
  Devpost): 1st $20,000, 2nd $10,000, 3rd $5,000, plus billboard, trophy, blog
  and 9to5 coverage. Source: https://shipaton.com/categories/hamm-award
- Design Award prize amounts for 2026 are not published on the pages fetched.
  For reference the 2024 Design Award paid 1st $5,000, 2nd $2,500, 3rd $1,000.
  Source: https://www.revenuecat.com/blog/company/2024-ship-a-ton-winners.
  Treat 2026 Design amounts as UNVERIFIED until the Devpost rules confirm them.

## How judging actually works (this drives every other decision)

Source for this whole section: https://www.shipaton.com/blog/how-we-judge-shipaton
and the criteria in https://revenuecat-shipaton-2025.devpost.com/rules

Four stages:

1. Intake filtering (Oct 1). Devpost entries are exported to an internal tool that
   verifies each entry: a live store link, a valid bundle ID / package name that
   confirms the RevenueCat SDK is really integrated, all required fields answered,
   a video and marketing materials (icon and screenshots) for Times Square. A lot
   of entries get filtered out here. Category questions decide which categories you
   are judged in: leave a category's question blank and you are not judged for it.

2. Prescreening. Every entry gets at least two RevenueCat screeners. They score
   the app 1 to 5 in each targeted category. They are required to watch the first
   2 minutes of the video and read the submission. They are not required to
   download the app, though they often do. What they want in the first two minutes:
   the elevator pitch, the app actually in use and how and why it targets each
   category. Explicit advice from RevenueCat: do not try to jam your app into every
   category.

3. Judge scoring. Named judges must read the entire description, watch at least two
   minutes of the video, review all screenshots and score 1 to 5 in each category.
   Downloading is encouraged, not required. Each judge nominates their top apps per
   category. Close to 100 apps reach this round.

4. Final selection (Oct 8-9). RevenueCat or the sponsor picks 1st, 2nd, 3rd from
   the nominees, revisiting description, video and screenshots and at least one
   RevenueCat developer advocate downloads the app to confirm it matches what the
   video shows.

Consequences for Bond, stated plainly:

- The first two minutes of the video are the whole ballgame at the screening
  stage. Two screeners, then judges, are only guaranteed to watch that. The
  elevator pitch, the app in use and the category fit must all land inside it.
- The app must be genuinely downloadable and must match the video, because a dev
  advocate installs the finalists. A video that shows features the app does not
  have loses at the last step.
- Answer the Design and HAMM category questions specifically and well. A blank or
  weak answer means no score in that category.
- Pick Design and HAMM deliberately and do not spray across all 21. Two strong,
  well-targeted category answers beat ten thin ones.
- The RevenueCat SDK must be really wired (they check the bundle ID) and judges
  need a way in: ship either a free trial or a promo code so they can unlock Pro.
  Source for the trial/promo requirement: the 2025 Devpost rules.

## Category 1: RevenueCat Design Award

What it rewards: "exceptional product craft, design, and animation" (2026 category
line, https://www.shipaton.com/). The 2024 rules framed it as innovative ideas,
beautiful design and animation.
Source: https://www.revenuecat.com/blog/company/2024-ship-a-ton-winners

Past Design Award winners and why they won:

- Dayloop (2025, 1st). Auto-aligns portraits into timelapse videos using Apple's
  Vision Framework, with Auto Face Alignment, a Ghost Photo overlay and a timeline
  slider. The writeup stresses on-device privacy and hours spent fine-tuning image
  alignment so the experience feels seamless. Lesson: one hard technical craft
  problem, solved so well it feels effortless.
- SkillMe (2025, 2nd). Breaks any skill into daily challenges. Design standout that
  the writeup calls out: it adapts the paywall copy to each user's chosen goal with
  context-specific nudges. Lesson: the paywall itself is treated as a designed,
  personalized surface, which is directly relevant to Bond wanting both awards.
- PitchLab (2025, 3rd). Turns an iPhone into pro pitch tracking with computer
  vision and CoreML at up to 60 fps, near radar accuracy. Lesson: polished
  real-time responsiveness reads as craft.
- Flowmino (2024, 1st, the first-ever Design Award). Time-blocking app using Screen
  Time APIs. It won for craft, with gentle animations and haptics that made it "an
  absolute joy to use." Lesson: micro-interactions, motion and haptics are what the
  judges literally quote.
Source for the 2025 winners: https://www.revenuecat.com/blog/company/shipaton-2025-winners

Design Award pattern: a focused app that does one thing with obvious craft, where
animation and haptics are purposeful (not decoration), the hard part feels
seamless and even the paywall is designed. For Bond that means the room view,
threading and the humans-plus-agents presence model have to feel alive: smooth
transitions, tasteful motion when an agent joins or a message is signed, haptics
on key actions and a paywall that matches the app's visual language.

## Category 2: HAMM (Help Apps Make Money)

What it rewards: "the smartest use of RevenueCat to drive revenue." Judges look for
a well-crafted paywall, thoughtful pricing and packaging, strong conversion and
monetization that genuinely fits the product, in a way that feels intentional and
sustainable. Source: https://shipaton.com/categories/hamm-award

What the HAMM submission should include (from the same page): your monetization
strategy, your paywall / pricing / packaging / trial approach, any conversion,
revenue, retention or purchase data you can share and how RevenueCat helped you
build, test or manage the monetization flow. The 2025 rules add that HAMM is scored
on clarity, creativity and financial viability of the monetization model.
Source: https://revenuecat-shipaton-2025.devpost.com/rules

Past HAMM / monetization winners and why they won:

- Vector Guard (2025, HAMM 1st). Tick and mosquito identifier. Won for its "1:50
  Justice Model," where each $2.99 subscription funds 50 free accounts in high-risk
  ZIP codes. Lesson: a pricing story with a clear, memorable model beat raw dollars.
- Napkinmatic AI3D (2025, HAMM 2nd). Sketch to 3D. Won for a hybrid model where
  users buy "Napkin Credits" that convert into Coins or subscribe for bundles via
  RevenueCat. Lesson: consumables plus subscriptions, both managed through
  RevenueCat, reads as smart packaging.
- Karo (2024, Most Likely to Make Money, 1st). Chat-style task manager. Won on
  monetization design: a Blinkist-style paywall with a secondary "View all plans"
  option, gating collaboration and AI features behind payment while the free tier
  still shows value, plus chat-based sharing that lowers onboarding friction and
  drives organic growth. Lesson and this one maps almost exactly onto Bond: gate
  the collaboration and AI, let the free tier prove value, use a single clear
  default plan with "view all plans" tucked behind a link.
- Zerocam Mono (2024, 2nd). Won on polished execution plus a tiered model
  ($1.99/month, $0.99/week, $19.99 lifetime). Lesson: clear tiers including a
  lifetime option.
Sources: https://www.revenuecat.com/blog/company/shipaton-2025-winners and
https://www.revenuecat.com/blog/company/2024-ship-a-ton-winners

HAMM pattern: monetization that fits the product, a paywall that is clearly
designed, a pricing model with a story and evidence. Bring real numbers if you can
(trial starts, conversion, MRR) and explicitly describe how RevenueCat powered it
(Paywalls, Offerings, Entitlements, A/B testing).

## RevenueCat's own data on what converts (use this to defend every choice)

### Paywall placement
Source: https://www.revenuecat.com/blog/growth/paywall-placement
- Show the paywall early, including during onboarding. The old "let them use it
  first" model underperforms.
- A plant app (Greg) moved from a usage gate (after 5 plants) to showing the
  paywall to everyone in onboarding: trial sign-ups rose about 400% and
  sign-up-to-trial went from 3% to 15%.
- Rootd, a mental wellness app, moved its paywall early in onboarding and saw a 5x
  revenue increase, despite fearing it would deter anxious users.
- The "aha moment" rule (Jake Mor, Superwall): get the user to the core value as
  fast as possible, then show the paywall right after. PhotoRoom lets you remove a
  photo background in onboarding (instant value), then paywalls immediately.
- Early paywalls mostly churn users who were never going to pay (Sylvain Gauchet,
  Babbel).

### Onboarding funnel
Source: https://www.revenuecat.com/blog/growth/fix-onboarding-funnels/
- Around 82% of subscription trial starts happen on day zero and historically over
  80% of subscriptions happened within two minutes of download. The onboarding is
  where the money is decided.
- Add a commitment screen just before the paywall (Flo, Headway, Duolingo do this):
  a pledge, a signature, a held thumb. It flips the mindset from "should I buy" to
  "should I stop what I already committed to." One sustainability app doubled day-30
  retention by adding a single "I'm committing to..." screen.
- Sell the promise, not the proof. Lead with why the app matters before what it
  does. Use onboarding questions to build a sense that the app understands the user.
- Longer, question-led onboarding tends to convert better. Do not bury the paywall
  behind so many steps that energy drains.
- The math: at 100k installs/month, lifting trial starts from 10% to 15% adds ~5,000
  trials and ~1,250 paying users at 25% trial-to-paid, with no extra ad spend.

### Paywall design
Source: https://www.revenuecat.com/blog/growth/guide-to-mobile-paywalls-subscription-apps
- How you present plans matters more than the value framing copy.
- Default to one plan (usually annual) and hide cheaper plans behind a "View all
  plans" link. Mojo did this and lifted yearly subs with minimal conversion loss.
  (This is the same Blinkist-style pattern Karo won HAMM with in 2024.)
- Use a decoy. Avast priced a 3-year license high to make the 2-year plan look
  attractive.
- Free trials make upgrade feel risk-free and trials longer than four days can
  convert above 60% for top-quartile apps.
- Show the monthly equivalent next to an annual price ("equivalent to X/month").
- Onboarding paywalls matter: at Mojo onboarding accounted for about 50% of trial
  starts. A direct upgrade button raised revenue 10-20% at Avast.
- Benchmarks: only ~1.7% of downloads convert to paying subscribers in the first 30
  days (top performers 4.2%) and about 38% of trial starters convert to paid.
- Avoid dark patterns: state trial length, renewal price and cancellation clearly.

### Animation (directly relevant to the Design Award)
Source: https://www.revenuecat.com/blog/growth/paywall-conversion-boosters
- Purposeful motion that guides attention (subtle button pulse, gentle entrance for
  pricing options, small movements highlighting value) can lift conversion 12-18%
  versus static. Animation as decoration does not. This is the sweet spot where
  Design craft and HAMM revenue reinforce each other.
- Also: clear benefit-led copy, prominent framed discounts ("Save 40%"), a trial
  featured across multiple touchpoints with "cancel anytime," and price anchoring
  ("just 33 cents a day", "less than a coffee a week").

## The actionable checklist for Bond

### A. Onboarding flow (the highest-leverage screen set)
- [ ] Keep it question-led and short enough to feel purposeful, not a slog. Ask 2 to
      4 questions that personalize Bond (who do you want in your rooms, which agents
      or tools do you connect, do you message teammates or run agents solo). Use the
      answers to tailor later copy, the way SkillMe adapts paywall copy to the goal.
- [ ] Deliver an aha moment before the paywall. For Bond that is: create a room, drop
      in a message and watch an agent respond in the thread (or see a message get a
      verified/signed badge). The user must feel the humans-plus-agents magic once.
- [ ] Add one commitment screen right before the paywall. Something true to Bond,
      e.g. "I'm setting up my agent workspace" or "Start building my verified space,"
      confirmed with a tap. Grounds in the onboarding-funnel data above.
- [ ] Lead with the promise (a shared space where your humans and your agents work
      together, verifiably) before listing features.
- [ ] Instrument install-to-trial and trial-to-paid separately from day one via
      RevenueCat, so you have numbers to put in the HAMM submission.

### B. Paywall placement and design
- [ ] Place the primary paywall inside onboarding, right after the aha moment. This
      is what Greg, Rootd and Mojo data supports and it is the single most defensible
      choice for HAMM.
- [ ] Add a second placement before the first locked action (connecting an extra
      agent/bridge, creating room N+1, inviting beyond the free cap). Both-and, not
      either-or.
- [ ] Build the paywall with RevenueCat Paywalls / Offerings so it is remote-config
      and A/B testable and say so in the HAMM writeup. Run at least one A/B test
      (headline or default plan) so you can report a result.
- [ ] Show one plan by default (annual), monthly and any lifetime option behind a
      "View all plans" link. This is the Karo/Mojo pattern that already won.
- [ ] Offer a free trial (aim for longer than 4 days) so judges can unlock Pro and so
      the trial-conversion data works in your favor. A promo code is the fallback the
      rules require either way.
- [ ] Show the monthly equivalent next to the annual price and anchor ("less than X
      a week"). Frame any discount as savings ("Save 40%").
- [ ] Use purposeful animation on the paywall: gentle entrance for the plan cards, a
      subtle pulse on the primary CTA, motion that highlights the headline benefit.
      This is where Design and HAMM overlap, cite the 12-18% figure internally.
- [ ] State trial length, renewal price and cancel-anytime clearly. No dark patterns,
      the judges explicitly reward the opposite and a dev advocate will notice.

### C. What to gate behind Pro (fits Bond, follows the Karo lesson)
Principle from the winners: let the free tier prove the core value, gate the
collaboration, the AI/agent power and the scale. Concrete split for Bond:
- [ ] Free: 1 to 2 rooms, a small cap on connected agents/bridges (e.g. 1 agent or 1
      bridge), basic threading, verified identity for yourself, a monthly cap on
      agent runs or messages. Enough to reach the aha moment and keep using it.
- [ ] Pro: more or unlimited rooms, multiple connected agents and bridge adapters,
      higher or unlimited agent-run / message quotas, advanced threading (e.g.
      branching or long-context), priority agent execution, message signing at scale
      and a verified badge for your space and any team/multi-human collaboration
      features. Gate the coordination and the agent capacity, since that is Bond's
      differentiator and the thing power users will pay for.
- [ ] Consider a consumable layer for heavy agent usage (credits for agent runs) on
      top of the subscription, both managed through RevenueCat. Napkinmatic won HAMM
      2nd with exactly this hybrid. Only do it if it genuinely fits, do not bolt it on.
- [ ] Give the pricing a one-line story for the HAMM answer (what Pro unlocks and why
      it is worth it), the way Vector Guard's "1:50" model was memorable.

### D. ASO basics (checked at intake and it is part of business viability)
Note: the fetched pages do not give a Shipaton-specific ASO rubric, so these are
standard ASO applied to the intake requirements. The 2024 business-viability
criteria explicitly list ASO alongside design, monetization and paywall.
Source: https://www.revenuecat.com/blog/company/2024-ship-a-ton-winners
- [ ] 1024x1024 app icon that reads at thumbnail size and matches the in-app look.
      Required at intake for the Times Square marketing.
- [ ] At least one screenshot at 1179x2556 with no device frame (a hard intake
      requirement in the 2025 rules) and ideally a full set of captioned screenshots
      whose first two carry the core promise.
- [ ] Title and subtitle that state the category and the one-line promise (humans and
      agents, one verified space). Put the primary keyword in the title.
- [ ] A short description whose first two lines land the pitch before the fold.
- [ ] Ship the store listing early. Build & Grow rewards early release and iteration,
      and an app live sooner has real usage data to show.

### E. Demo video structure (hard cap ~3 min, but the first 2 minutes decide it)
The rules say judges are not required to watch beyond three minutes and the video
must show the app actually running on the device. Screeners are only guaranteed to
watch the first two minutes, so treat 0:00 to 2:00 as the entire pitch and keep the
whole thing under 2 minutes if you can. Sources:
https://revenuecat-shipaton-2025.devpost.com/rules and
https://www.shipaton.com/blog/how-we-judge-shipaton
- [ ] 0:00-0:15 Elevator pitch in one sentence, over the app on screen. What Bond is
      and who it is for. Say the name.
- [ ] 0:15-0:45 The aha moment as a real screen recording: create a room, message,
      an agent replies in-thread, a message shows its verified/signed badge. Show it
      working on a real device, not slides.
- [ ] 0:45-1:15 Craft and polish beat for the Design Award: linger on the
      transitions, the motion when an agent joins, haptics, the threading UI. Let it
      look like "a joy to use," which is the exact phrase Flowmino won on.
- [ ] 1:15-1:45 Monetization beat for HAMM: show the paywall in context (in
      onboarding, after the aha moment), name the free-vs-Pro split and say one line
      on pricing and the story behind it. Mention it is powered by RevenueCat.
- [ ] 1:45-2:00 Traction / proof and close: any real numbers (users, trials,
      conversion, MRR), the store link and a clean sign-off. Numbers here feed both
      HAMM and Build & Grow.
- [ ] Explicitly name the two target categories and why Bond fits each, once, in the
      video and again in the Devpost description. Do not claim categories you are not
      entering.
- [ ] Everything shown must be real and must match the shipped app, because a dev
      advocate downloads finalists to confirm. No mocked screens.
- [ ] Use only licensed or original music (the rules forbid unlicensed copyrighted
      music and third-party trademarks). Post the video public on an approved
      platform (YouTube etc.).

### F. Submission hygiene (intake filters a lot of entries out)
- [ ] Live store link, app first released inside Aug 1 to Sep 30, 2026.
- [ ] RevenueCat SDK genuinely integrated (they verify via bundle ID / package name).
- [ ] All Devpost fields answered, especially the Design and HAMM category questions,
      written specifically and backed with detail and data.
- [ ] Free trial or promo code provided so judges can unlock Pro.
- [ ] Icon and screenshots at the required sizes for Times Square marketing.
- [ ] Video public, under the cap, front-loaded.

## Where Design and HAMM reinforce each other (aim here)
The winning move is one app that is both. SkillMe's personalized paywall copy and
the 12-18% animation lift show that a beautifully designed, animated, personalized
paywall scores for Design craft and drives the conversion HAMM rewards. Build the
paywall as a first-class, animated, on-brand screen, place it after the aha moment,
give the pricing a story, wire it through RevenueCat with an A/B test and capture
the numbers. That single artifact is the strongest thing you can put in front of
both sets of judges.

## Sources (primary)
- How we judge Shipaton: https://www.shipaton.com/blog/how-we-judge-shipaton
- Shipaton 2026 home (categories, prize pool): https://www.shipaton.com/
- HAMM category page: https://shipaton.com/categories/hamm-award
- Announcing Shipaton 2026 (dates, categories, changes):
  https://www.revenuecat.com/blog/company/announcing-shipaton-2026/
- Shipaton 2025 winners: https://www.revenuecat.com/blog/company/shipaton-2025-winners
- 2024 Ship-a-ton winners: https://www.revenuecat.com/blog/company/2024-ship-a-ton-winners
- 2025 Devpost rules: https://revenuecat-shipaton-2025.devpost.com/rules
- Paywall placement: https://www.revenuecat.com/blog/growth/paywall-placement
- Onboarding funnels: https://www.revenuecat.com/blog/growth/fix-onboarding-funnels/
- Guide to mobile paywalls: https://www.revenuecat.com/blog/growth/guide-to-mobile-paywalls-subscription-apps
- Paywall conversion boosters (animation): https://www.revenuecat.com/blog/growth/paywall-conversion-boosters

## Unverified / gaps
- Exact 2026 Design Award prize amounts were not on the fetched pages. 2024 paid
  $5,000 / $2,500 / $1,000. Confirm on the 2026 Devpost rules before quoting.
- The dedicated 2026 Design Award category page (shipaton.com/categories/design-award)
  returned 404 on fetch. The Design description used here is the one-line summary on
  the shipaton.com home page plus the 2024 rules wording.
- No Shipaton-specific ASO rubric was published on the fetched pages. The ASO section
  applies standard practice to the intake requirements that are documented.
- The under-2-minute video timing is a design choice derived from the documented
  facts (3-minute cap, screeners guaranteed only the first 2 minutes). The rules do
  not mandate a 2-minute video.
