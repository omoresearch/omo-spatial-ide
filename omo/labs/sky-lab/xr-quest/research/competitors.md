# Competitor teardown: Meta Quest productivity apps (22 Nov 2026)

How this was made: each public Meta Horizon Store page was read in headless Chrome. I was not logged in, so the
pages show AU prices. Raw page text, the Store review text (5 to 20 reviews per app, "most relevant" order) and a
capture of each Store page top are saved in `research/raw/`:
  <app>.txt (listing), <app>-reviews.txt (reviews), <app>-store-top.jpg (hero media), media.json (media counts).
The quotes below are copied from those files, or from the linked Reddit/App Store/vendor pages. Long quotes are cut,
and "..." marks each cut. US prices come from third-party price trackers (linked). Treat them as approximate.

Store pages read (all fetched 22 Nov 2026):
- Immersed        https://www.meta.com/experiences/immersed/2849273531812512/
- Virtual Desktop https://www.meta.com/experiences/virtual-desktop/2017050365004772/
- OVERAY DESK     https://www.meta.com/experiences/overay-desk/26327922833566636/
- Fluid           https://www.meta.com/experiences/fluid/6946182742093178/
- Arthur          https://www.meta.com/experiences/arthur/2108767382537806/
- Zoom Workplace  https://www.meta.com/experiences/zoom-workplace/8899655123384953/
- Teams Immersive https://www.meta.com/experiences/microsoft-teams-immersive/25025465670425260/
- Windows App (this is "Meta Quest Remote Desktop" on Windows 11) https://www.meta.com/experiences/windows-app/26866090656322634/

Market context:
- Meta Horizon Workrooms closed on 16 Feb 2026 (https://meta.com/help/quest/2464765133873078 ,
  https://theverge.com/tech/863209/meta-has-discontinued-its-metaverse-for-work-too).
- Microsoft Mesh apps retired on 1 Dec 2025 (Mesh Store page). Teams immersive events retire on 2 Apr 2027
  (https://support.microsoft.com/en-us/teams/meetings/attend-an-immersive-event-in-microsoft-teams).
- Meta Horizon managed services stopped new sales on 20 Feb 2026 (https://forwork.meta.com/isv-directory/).

## Summary table

| App | Price (Store, AU / US) | Rating (count) | Needs a PC? | Account? | Seated/standing | Trailer |
|---|---|---|---|---|---|---|
| Immersed | Free; Pro paid ("as low as $5"/mo, immersed.com/modes) | 4.3 (4.3K) | Yes, streams your Mac/PC/Linux | Yes | Sit, stand, roomscale | 1:07 video |
| Virtual Desktop | AU$38.99 / US$24.99 one-time | 4.3 (10K) | Yes (streamer app) | No (Meta ID) | Sit, stand, roomscale | 1:59 video |
| OVERAY DESK | AU$37.99 / US$24.99 one-time (US$19.99 on sale) | 4.1 (14) | Yes (host app) | Yes (email) | Sitting only | 0:52 video |
| Fluid | AU$12.99, Early Access; rooms AU$10.99-13.99; paid PC add-on | 4.5 (1.1K) | No (on-headset browser) | Yes (email) | Sit, stand, roomscale | 0:34 video |
| Arthur | Free Consumer; Pro edition for enterprise | 3.6 (51) | No | Yes | Sit, stand, roomscale | 1:28 video |
| Zoom Workplace | Free; Zoom paid plans for >40 min | 3.7 (12) | No | Zoom login | Sitting | Static logo + screenshots |
| Teams Immersive | Free; needs Teams + often Horizon Managed Services | 1.6 (13) | PC to create events | Microsoft work login | All | 1:39 video |
| Windows App / Remote Desktop | Free | 2.9 (202) | Windows 11 PC or Cloud PC | Microsoft | Sit, stand | Static logo + screenshots |

US price sources: https://psprices.com/region-us/game/8014346/virtual-desktop ,
https://queststoredb.com/app/overay-desk-26327922833566636/ , https://desk.overay.com/blog/en/overay-desk-official-launch/

---

## 1. Immersed (Immersed Inc.)
- Price: free download. Starter mode has "up to 3 virtual screens"; Pro is paid (https://immersed.com/modes).
  Store: 4.3 from 4.3K ratings; 78% give 5 stars, 13% give 1 star. Version 2.42.0. 706 MB. 12+, "Users Interact".
- What users praise: multiple big screens in nice worlds, free tier, public coworking cafe, USB link.
  - "Love the system where you can earn the pro features. The support team is great" (T3Q0, Store)
  - "most importantly i can stay in the zone, phone far from me!" (Allyyyy, Store)
  - "I have back problems so now I'm able to get on my computer more comfortably. I lay down to use my meta"
    (Skydreams4evr, Store)
  - "Immersed does exactly this. You can join public rooms, like a cafe" (r/MetaQuestVR)
- Top 5 complaints (quoted):
  1. Trust/brand damage from the Visor hardware pre-order: "2+ years later, still no product, and when I made a comment
     on Discord, they booted me off their server ... I sent an email asking for a refund ... all I got was CRICKETS!"
     (ezgadgets, Store, 1 star). See also r/ImmersedVisor "I'm Done", and "Immersed Visor ... was it vaporware?"
     (https://reddit.com/r/virtualreality/comments/1oimvo8).
  2. High PC load: "Immersed uses far more CPU than it should ... more than 40% CPU usage compared to native"
     (ShanetheFreestyler, Store). "Mouse doesnt work, cpu load berserk" (MiguelAAzevedo, Store).
  3. Features removed: "the way they took away useful features and then savagely stopped people from being able to
     comment" (RichSterling, Store). "As soon as Immersed killed support for external monitors on Windows, I shifted
     over to Overay" (MavericRFW, OVERAY DESK Store review).
  4. Text quality and eye strain: "The text still shimmers and does not seem to be as high res as it could be"
     (Apple App Store review, https://apps.apple.com/us/app/immersed/id6478354845). "If I have to in a single word:
     headache. I tried a couple of days using immersed" (https://reddit.com/r/OculusQuest/comments/1dspx8g).
  5. Data/privacy worry: "This invasive app is mogged by virtual desktop" (Max.SE, Store); "could potentially lead to
     your data being used in ways you did not anticipate" (ezgadgets, Store). The Store lists eye tracking, facial
     expressions, location and Bluetooth as data the app may request.
- Screenshots/trailer style: a 1:07 trailer. It opens on a sunlit wood-panelled office above a city skyline. A
  stylised avatar sits at curved floating monitors (web, map, code). Large lowercase "immersed" and
  "desktop + coworking" text sit on top. Screenshots: a purple-lit multi-screen room, a real person in a headset next
  to an avatar, a space station and a neon room. (raw/immersed-store-top.jpg)

## 2. Virtual Desktop (Guy Godin)
- Price: AU$38.99 / US$24.99 one-time (lowest seen US$19.99). "Top seller" badge. 4.3 from 10K ratings (5.1K
  reviews); 74% give 5 stars. 3+. No account; works offline after the first check.
- What users praise: best wireless PC streaming, image quality, low latency, many environments.
  - "The connection is smooth, the image quality is amazing, and the performance is excellent" (Yachak, Store)
  - "this app gives you many environments and video players. This is a one-stop shop for pc vr!" (Lu_Million, Store)
  - "Virtual Desktop (superb, and the real benchmark, although only 3 monitors)" (Spiral_Plus, OVERAY DESK Store review)
- Top 5 complaints (quoted). The newest reviews are dominated by a November 2026 forced update:
  1. Forced updates and a server check: "the desktop companion streamer app will auto-update to the latest version with
     no option of disabling or rolling back updates" (DrFluffyNips, Store); "cancelling the update still leaving the
     program disabled by a remote switch" (rabbitruno, Store).
  2. Breaks for work on the move: "You try to work from a different city ... there is no pc to connect, because the
     updater brakes the connection, and it happens all the time!!!!" (phase.boi, Store)
  3. Developer attitude: "while communicating the frustration they mute you" (NarVo, Store); "Dev also seems a bit
     unstable and hostile to customers for saying anything critical" (wolVenom, Store).
  4. Unstable after updates: "This recent update has completely destroyed my audio" (ImperfectAce, Store); "Worked
     completely fine for a year, but after the recent update it straight up just doesnt work anymore"
     (lordofplowing, Store).
  5. Hand and mouse input, and text for work: "Requires controllers to interact with (hand tracking and Bluetooth mouse
     are not able to access many menu elements)" (XyLikesButts, Store). "The text editor is blurry in VS 2022. Also, I
     can't see my keyboard and mouse" (https://reddit.com/r/Quest3/comments/1j7xojy).
- Screenshots/trailer style: a 1:59 trailer with no text on the frame. It opens on a dim high-rise loft at sunset with
  wall screens showing wallpapers. Screenshots: a media grid, a neon gaming room, a sci-fi room, a cinema and a beach.
  It sells mood and places, not work. (raw/virtual-desktop-store-top.jpg)

## 3. OVERAY DESK (Overay Studio, Korea)
- Price: AU$37.99 / US$24.99 one-time, "Pay once. No subscription" (US$19.99 sale ended 29 Sep). It became paid on
  7 Jun 2026; the old free "Legacy" app has 3.9 (34). 4.1 from 14 ratings. Sitting only. "Internet connection
  required". Up to 5 monitors. Browser, notes, Pomodoro timer and an XR pen. Saved layouts.
- What users praise: flexible multi-monitor layouts, a responsive dev team, extras such as sticky notes and a pen.
  - "Overay Desk, ranks in the top 2. Support is more professional and friendly than Immersed" (Spiral_Plus, Store)
  - "I was able to make virtual displays on the fly very easily. Having sticky notes in your environment..."
    (MavericRFW, Store)
  - "I love being able to get some light work done from the couch instead of sitting at my PC" (BrushCutter, Store)
- Top complaints (only 9 reviews exist; all critical ones are quoted):
  1. Account sign-up broke: "When you install the Mac app and set up with your email address you don't get a verify
     email ... so you don't get to use the app. Do NOT buy" (BrianOfIreland, Store; the dev confirmed an auth bug).
  2. Connection fails: "Sucks! Won't connect. Wasted money." (Atomic_ADHD, Store)
  3. PC install crashes: "I really should have contacted the developers before throwing my keyboard" (Sleeping.Sneeze,
     Store; the dev reply mentions "PC crash and installation errors").
  4. Setup takes effort: "Took me a little while to get everything set up the way I wanted" (nowkoo890, Store)
  5. Support only through Discord, and no Linux yet: every dev reply sends users to Discord; Linux is promised:
     "We're working hard on Linux support" (dev reply, Store).
- Screenshots/trailer style: a bright lifestyle 0:52 trailer. A smiling person on a sunlit sofa wears a Quest 3 in
  passthrough, with three curved screens (code, a web page that says "Stay in the flow.", a photo grid). Bold
  "OVERAY DESK" and "ARRANGE 5 MONITORS | ANYWHERE" text. Screenshots: numbered monitors in ocean, space, desert and
  meadow worlds. (raw/overay-desk-store-top.jpg)

## 4. Fluid (Fluid Technologies, Early Access)
- Price: AU$12.99, Early Access. Paid rooms (Dunes AU$13.99, Campus AU$10.99). Paid experimental "Fluid Link" PC add-on.
  4.5 from 1.1K ratings. "Internet connection required". Email account required. Runs on the headset; "up to 11
  browser windows" (https://docs.fluid.so).
- What users praise: no PC needed, windows anywhere, nice environments, watching together.
  - "We used it how we would use a shared theatre watching experience like BigScreen. It worked flawlessly"
    (KhaiZhen, Store)
  - "I like moving the screens to watch a show sitting in lawn chairs over looking the sand dunes" (Vegas907, Store)
  - "It's what the Meta browser should have been" (https://reddit.com/r/OculusQuest/comments/1d7e4xg)
- Top 5 complaints (quoted):
  1. Slow and buggy: "still very sluggish. Buggy and lots of limitations" (Yann_VR_FromUpNorth, Store); "Unusable in
     every way on Meta Quest 3 now ... I still had to restart the app three times just to get past the terms"
     (RIPKodaBear, Store).
  2. Forced account: "I bought it, now i cant use what i bought without creating an account? something that is not
     easy to do in vr" (ceruleanalpha, Store); "you can never complete the sign-up process" (del.jones.1953, Store).
  3. Lost purchases: "I paid for the full version ... bought 3 additional rooms. Now ... it tells me I am in guest mode
     and I have to buy it again" (jennie5661, Store); "i bought the app but it's won't let me leave guest mode"
     (Jaythejoker, Store).
  4. No offline mode: "Why ... would you make it so you cannot use this offline??????" (Gawkyorange5, Store)
  5. Nickel-and-dime pricing and loose privacy: "expect to pay exstra for every additional functionality"
     (Omnisayaah, Store); "the usual BS about 'anonymized' data and sharing with 'third party'" (pilot4, Store).
- Screenshots/trailer style: a 0:34 trailer on a dark room with a gradient "Fluid" logo, "Browser + Video Player" and a
  floating screen showing a racing game. Screenshots: a home theatre, floating windows over a sofa, and virtual hands
  typing. It sells media first and work second. (raw/fluid-store-top.jpg)

## 5. Meta Quest Remote Desktop / Windows App (Microsoft, with Meta)
- Price: free. On Windows 11 it pairs through Mixed Reality Link; on Mac or older Windows it uses Meta Quest Remote
  Desktop (https://meta.com/help/quest/1370025034331518). 2.9 from 202 ratings. Works offline. Quest 3/3S only.
- What users praise: free, crisp text, simple when it works, no extra PC software beyond Microsoft's.
  - "Text is legible in any mode: Compact, Standard, Wide, Ultra Wide ... Focus Mode: Dims the background"
    (MalakM, Store)
  - "Working on windows machines is fast, stable and because of RDP there is no additional software needed on PC"
    (djxmas, Store)
- Top 5 complaints (quoted):
  1. QR pairing fails: "you can't get past the QR code setup and there's no option to do it another way"
     (Thatgamekid, Store); "Didn't give QR code" (cc_ranger, Store); "Just crashes after qr code" (TheFrunk, Store).
  2. Updates break it: "Since the last update this week (2026.03.20) it is not possible to connect" (Greg.Szabo, Store)
  3. Same network only: "Needs to be truly 'Remote' that means no need to be on the same Wifi network as my PC"
     (MalakM, Store); "if you have dedicated router or wired connection you cannot use it" (kingnoki17, Store).
  4. Only mirrors the PC: "it seems like all it's doing is mirroring and I can't really interact the way I expected"
     (juanjuan2925, Store)
  5. Stuck loading screens: "all I get is a spinning loading screen. Classic meta" (JR4D, Store); "Remote Desktop ...
     says 'not available'" (https://reddit.com/r/OculusQuest/comments/1o7kzu1).
- Screenshots/trailer style: a static Windows-logo banner, then passthrough-style shots of real homes and offices with
  floating Windows monitors. No trailer and no text on the images. (raw/windows-app-store-top.jpg)

## 6. Arthur (Arthur Technologies)
- Price: free Consumer Edition; Professional Edition for enterprise (https://www.arthur.digital/product).
  3.6 from 51 ratings. Repositioned as "the space where humans and AI work together". Controllers only.
- What users praise: realistic avatars, uploading your own 3D content, building tools for enterprise workshops.
  - "avatars are really realistic" (hussaanharoon.2023, Store); "the ease with which you can upload and use your own
    content" (chris-xr, Store); G2 gives 4.8 from 19 reviews (https://www.g2.com/products/arthur-technologies-gmbh-arthur/reviews).
- Top 5 complaints (quoted; only 13 Store reviews exist):
  1. "Just kept sending me in loops and coming up with error messages. Waste of time" (Andy.walcot, Store)
  2. "I cannot even register an account. Error Please try again" (Mika_Simba, Store)
  3. "It looks like the developers put form over function ... Whats the use of a productiviy app that does not have much
     functionality?" (Big_Rodneigh, Store)
  4. "Seemed capable, but somewhat sterile." (byteframe, Store)
  5. No solo desk work: "the only thing needed here is solo rooms or a way to open desktop/laptop screens and work prior
     to meetups. Would love to not have to use horizon or immerse to do laptop work" (Bourbonblack, Store)
- Screenshots/trailer style: a 1:28 corporate trailer that opens on a lobby wall with 3D "ARTHUR" letters. Screenshots:
  business-suit avatars at sticky-note boards in bright atria. (raw/arthur-store-top.jpg)

## 7. Zoom Workplace (Zoom)
- Price: free; any Zoom licence; meetings over 40 min need Zoom Pro. 3.7 from 12 ratings. Sitting, controllers only.
- What users praise: join meetings as your Meta avatar with no camera.
  - "on days I don't feel like being on camera, it's super convenient" (MPRachel, Store); "Pretty cool to be able to
    use your VR Avatar in a Zoom Call! Movements are tracked" (M4cheteColletti, Store)
- Complaints (only 6 reviews; all critical ones quoted):
  1. "Can't log in no matter what. Gives log in failed 5003 error" (watson_wat_son, Store)
  2. "I get a zoom screen like in a virtual desktop. But I don't get an avatar" (RDMueller, Store)
  3. "this really needs support for Zoom rooms ... makes it unfortunately largely unusable for me" (martinknudsen, Store)
  4. Avatar framing: "I want to know if there's a way to change the distance between the Avatar and the camera"
     (MalakM, Store)
  Fewer than 5 distinct complaints exist on the Store.
- Screenshots/trailer style: a flat blue "zoom" logo hero (no trailer). Screenshots show webcam grids floating in a dim
  wood lounge. (raw/zoom-workplace-store-top.jpg)

## 8. Microsoft Teams Immersive (Microsoft)
- Price: free, but needs a Teams work account. "Most organisations may require Quest devices to be enrolled with
  Horizon Managed Services", and Meta stopped selling that on 20 Feb 2026. 1.6 from 13 ratings. Retires 2 Apr 2027.
- What users praise: almost nothing on the Store; one 5-star review says "its good".
- Complaints (only 5 reviews; all critical ones quoted):
  1. "I could never log into my teams account - some error about azure and stuff" (PF_VLA, Store)
  2. "Authentication fails and load times are abysmal." (Eburgosjr, Store)
  3. "Horrible can even sign in, the app won't load after entering email." (charliehustlemo314, Store)
  4. "Everything I atempt to login into teams with my microsoft account I experience authentication issues."
     (1Who_brings_the_Rain, Store)
  Fewer than 5 distinct complaints exist; all of them are about sign-in and loading.
- Screenshots/trailer style: a 1:39 trailer with cartoon Mesh-style avatars talking on a sunny desert patio. Event and
  stage shots. (raw/teams-immersive-store-top.jpg)

---

## Patterns across all eight (input for step 2)
1. Every desk app is "your PC, streamed into a void or a room". All of them need a host PC, except Fluid (a browser) and
   the meeting apps. None of them shows work that keeps running while you are away from a screen.
2. The biggest source of 1-star reviews is not features. It is broken trust: forced updates (Virtual Desktop),
   vapourware hardware (Immersed), lost purchases (Fluid), and logins that fail (Zoom, Teams, Fluid, OVERAY, Arthur).
3. Forced accounts are hated in VR ("something that is not easy to do in vr"). Pairing steps (QR codes, host apps,
   same Wi-Fi) are the second biggest failure point.
4. Text clarity and eye strain are the lasting productivity complaints (Immersed shimmer, VD blurry VS 2022).
   Windows App is praised exactly for "Text is legible".
5. Social/meeting apps are dead or dying: Workrooms is gone, Mesh is gone, Teams Immersive retires in Apr 2027 at 1.6
   stars, Arthur has pivoted to enterprise. No consumer app combines "my desk" with "people around me" well.
   Immersed's cafe is the nearest one, and its brand is damaged.
6. Store media: the desk apps all lead with a trailer of a beautiful room plus floating screens. OVERAY is the only one
   that shows a real person in passthrough. Few show the actual text up close, and none shows a terminal or an AI
   agent at work.

What we must not promise (from these failures): no forced account on first launch, no forced-update kill switch, no
claim of PC streaming (we do not stream a desktop), no "works offline" unless tested, and no fps claim without a
headset measurement.
