# Real-world testimony-conflict inventory

Compiled 2026-11-03. Inventory only: no bulk downloads were made. "Opened" means I fetched and read the page or document (opinion text was read from the Caselaw Access Project's free static copy at `static.case.law`, which gives official reporter pagination). "Inferred" or "unverified" means I did not open it.

CourtListener's search pages and API refused anonymous access (HTTP 403 / "authentication required"), so docket-level RECAP checks were only possible where a direct `storage.courtlistener.com` file URL was already known. Treat every "PACER only" note below as unverified.

## Summary table

| # | Case | Witnesses | Judicial document identifies conflict? | Transcripts available for both? | Certified or archive | Missing pieces | Recommended? |
|---|---|---|---|---|---|---|---|
| 1 | Jones v. Clinton (E.D. Ark. 1999) | Clinton (Jones deposition) vs Clinton (grand jury); also vs Lewinsky (affidavit, grand jury) | **Yes (opened)**, with transcript page cites. The judge's finding is about the same witness across two sessions; the Clinton vs Lewinsky conflict comes from Congress, not the court | Yes. Official GPO prints (Senate Doc. 106-3 / H. Doc. 105-311, 105-316) | Official government release | Page numbers only, no line numbers, in the opinion's cites. The GPO PDFs are large scanned volumes, and I did not check whether they have a text layer. Only the "publicly available portions" of the deposition | **Yes, start here** |
| 2 | Tolan v. Cotton (U.S. 2014) | Sgt. Cotton vs Robbie Tolan, his father Bobby Tolan, his mother Marian Tolan; Officer Edwards vs Tolan | **Yes (opened)**: four specific conflicts, with record page cites | **Unverified.** Most likely only through PACER (S.D. Tex.) or the Fifth Circuit record | Would be certified (court record) | Depositions not found free online. Some cited testimony is from Cotton's criminal trial, not a deposition | Yes if the record can be got; best cross-witness example |
| 3 | United States v. Philip Morris (D.D.C. 2006) | J. Kendrick Wells vs Jeffrey Wigand (fate of the Vancouver meeting minutes) | **Yes (opened)**, but in general terms: "does not credit the testimony of either" | Wigand: yes (DOJ PDF). Wells: unverified | Official DOJ release (Wigand) | Wells's testimony not found. Written direct testimony and trial testimony rather than depositions. No pin to specific conflicting lines | Possible, weak |
| 4 | Giuffre v. Maxwell (S.D.N.Y. 2015-17) | Ghislaine Maxwell vs Virginia Giuffre | **Unverified.** The March 2017 summary judgment denial (76 pp., heavily redacted) exists, but I did not find or open its text | Maxwell: yes (RECAP, ECF 1137-13, 465 pp.). Giuffre: partly unsealed, location unverified | Certified court filing (RECAP) | Judicial pin cite. Giuffre deposition URL. Heavy redactions. Sensitive content involving minors | Not as a first case |
| 5 | Georgia v. Trump: Willis disqualification order (Fulton Super. Ct. 2024) | Robin Yeartie and Terrence Bradley vs Fani Willis and Nathan Wade (when the relationship began) | Reported yes ("odor of mendacity"); **order text not opened** | Hearing testimony; official transcripts unverified (video is public) | Unverified | Official transcripts; hearing testimony, not depositions | No |
| 6 | Epic Games v. Apple: contempt order (N.D. Cal., Apr. 30, 2025) | Apple VP Alex Roman's testimony vs contemporaneous documents (and Phil Schiller's evidence) | Reported yes (Roman "outright lied under oath"); **order not opened** | Evidentiary-hearing transcripts; free availability unverified | Would be certified | The conflict is mainly testimony vs documents, not witness vs witness | No |
| 7 | United States v. Bankman-Fried (S.D.N.Y. 2023-24), criminal | Bankman-Fried vs Caroline Ellison | Reported yes: perjury findings at sentencing, Mar. 28, 2024 (news only, **not opened**) | Trial transcripts; free source unverified | Unverified | Criminal, not civil. Trial testimony, not depositions. Sentencing transcript not located | Only if trial testimony is acceptable |
| 8 | Rufo v. Simpson (Cal. Ct. App. 2001) | Simpson vs Faye Resnick (as you asked) | **No (opened).** The appellate opinion never mentions Resnick | Depositions exist as archive-derived HTML (not re-checked here) | Archive-derived | No judicial identification of a conflict between witnesses | No |
| 9 | United States v. Microsoft (D.D.C. 1999) | Microsoft vs Netscape witnesses (June 1995 meeting) | **No (opened).** The Findings of Fact give no testimony citations or credibility conflicts | Yes. DOJ posts deposition excerpts as played or admitted in court | Official DOJ release | No court-identified conflict | No, but a good source of official transcripts |

Not a court case, so excluded from the table: the House January 6 Committee transcripts (Cassidy Hutchinson vs Tony Ornato and Bobby Engel on the limousine/SUV account). The transcripts are official GPO releases, but **no judicial document** finds the conflict. This is noted because the project memory already tracks it.

---

## 1. Jones v. Clinton

- **Case:** Paula Corbin Jones v. William Jefferson Clinton and Danny Ferguson, U.S. District Court, E.D. Arkansas, No. LR-C-94-290. Contempt order April 12, 1999 (Judge Susan Webber Wright), reported at 36 F. Supp. 2d 1118 (pp. 1118-1135).
- **Conflict (as the court finds it):**
  - Clinton (deposition, Jan. 17, 1998) vs Clinton (grand jury, Aug. 17, 1998), on whether he had ever been **alone** with Monica Lewinsky. At the deposition he did not recall being alone with her and believed Betty Currie was present. Before the grand jury he said he was alone with her "on certain occasions."
  - Same two sessions, on **"sexual relations"**: he denied them at the deposition (and called Lewinsky's denial affidavit "absolutely true"). Before the grand jury he admitted "inappropriate intimate contact."
- **Judicial document (opened):** the Memorandum Opinion and Order of April 12, 1999. Text: https://static.case.law/f-supp-2d/36/cases/1118-01.json and, with page markers, https://static.case.law/f-supp-2d/36/html/1118-01.html
  - Deposition questions quoted at **36 F. Supp. 2d at 1127-28**, citing "Pres. Depo. at 52-53, 56-59". Also at 1128: "At his August 17th appearance before the grand jury, the President **directly contradicted his deposition testimony** by acknowledging that he had indeed been alone with Ms. Lewinsky on a number of occasions …" (citing "Pres. GJ Test. at 9-10", "Id. at 134").
  - On sexual relations, at about 1128-29: the court cites "Pres. Depo. at 78" and "at 204" against "Pres. GJ Test. at 9-10, 38-39, 54, 92-93 …".
  - At about 1130: "the President's deposition testimony regarding whether he had ever been alone with Ms. Lewinsky was intentionally false, and his statements regarding whether he had ever engaged in sexual relations with Ms. Lewinsky likewise were intentionally false." The page numbers come from the CAP page markers. Confirm them against the bound reporter before relying on them.
- **Conflict between two different witnesses (non-judicial):** the House Judiciary Committee report, H. Rept. 105-830 (reprinted as Senate Doc. 106-3, Vol. XV, opened at https://www.govinfo.gov/content/pkg/GPO-CDOC-106sdoc3/html/GPO-CDOC-106sdoc3-15.htm), says: "President Clinton's characterization of the relationship directly contradicts Ms. Lewinsky's testimony …". It pin-cites the Clinton grand jury testimony (e.g. pp. 8-9 = H. Doc. 105-311 pp. 460-61), the Lewinsky grand jury testimony of Aug. 6, 1998 (e.g. p. 152 = H. Doc. 105-311 p. 872), the Lewinsky deposition of Aug. 26, 1998 (p. 58 = H. Doc. 105-311 p. 1337) and the Betty Currie grand jury testimony (H. Doc. 105-316 pp. 559-584). This is a congressional committee, not a court.
- **Transcripts:**
  - Clinton's Jones deposition (Jan. 17, 1998): Senate Doc. 106-3 Vol. XXII, "Publicly available portions of the Deposition of William Jefferson Clinton in Jones v. Clinton". PDF: https://www.govinfo.gov/content/pkg/GPO-CDOC-106sdoc3/pdf/GPO-CDOC-106sdoc3-22.pdf (HEAD check: 3.76 MB PDF). The HTML version is only a stub. Vol. XIV holds the executive-session release of pp. 6-11, 19-26, 48-85 and 203-205. Official GPO print of the court reporter's pages. **Complete vs excerpted:** "publicly available portions" only. The opinion cites pages up to 204, so the transcript runs to at least about 205 pages (estimate).
  - Clinton's grand jury testimony (Aug. 17, 1998): H. Doc. 105-311 (Starr Referral appendices), about pp. 453-600 of that volume (inferred from the House report's cites), so about 150 transcript pages. Reprinted in Senate Doc. 106-3 Vol. III, Pts. 1-2. PDFs: https://www.govinfo.gov/content/pkg/GPO-CDOC-106sdoc3/pdf/GPO-CDOC-106sdoc3-3-2.pdf (24.5 MB) and `...-3-3.pdf` (20.1 MB). HEAD checks only, not opened. Which PDF holds which pages is **unverified**. Official, complete.
  - Lewinsky's grand jury testimony (Aug. 6 and 20, 1998) and deposition (Aug. 26, 1998): H. Doc. 105-311, same volumes. Official. Inferred from the House report's page cites, not opened.
  - Betty Currie's grand jury testimony: H. Doc. 105-316 (Senate Doc. 106-3 Vol. IV). Official. Not opened.
- **Deposition vs other testimony:** the court relied on the deposition and on the grand jury transcript, quoting both verbatim. That is exactly the "same witness, two sessions" situation the product is built for.
- **Licensing and redaction:** U.S. government works (public domain). The material is sexually explicit. The deposition is released only in part. The GPO PDFs are probably scans of the printed volumes (text layer unverified), and transcript pages are printed several to a volume page. The opinion cites pages, not page:line.

## 2. Tolan v. Cotton

- **Case:** Tolan v. Cotton, 572 U.S. 650 (2014) (per curiam), No. 13-551, decided May 5, 2014. It reversed the Fifth Circuit, 713 F.3d 299 (5th Cir. 2013), No. 12-20296. The district court was S.D. Texas; the docket is often given as 4:09-cv-01324, but that is **unverified**.
- **Conflicts identified by the Court (opened; CAP text https://static.case.law/us/572/html/0650-01.html, at 572 U.S. 657-59):**
  1. **Lighting:** Cotton's deposition says the porch was "fairly dark". Bobby Tolan's deposition says the gas lamp was not merely decorative (Record 1552). Robbie Tolan's deposition says two floodlights were on and he was "not in darkness" (Record 2496, 2498-2499). Cotton acknowledged the motion lights (Record 1034).
  2. **Mother's demeanor:** Cotton's deposition says she was "very agitated" (Record 1032-1033). She testified at Cotton's criminal trial that she was not (Record 2075, 2077).
  3. **Shouting or threat:** Tolan testified that he "was not screaming" (Record 2544).
  4. **Position when shot:** Edwards said Tolan was in a crouch or "charging position" (Record 1121-1122). Tolan's deposition says he "wasn't going anywhere" and did not "jump up" (Record 2502, 2544). The opinion also cites his trial testimony and his mother's (Record 1928, 2081).
  - Quote (at 657): "In his own deposition, however, Tolan's father was asked whether the gas lamp was in fact 'more decorative than illuminating.' Record 1552. He said that it was not."
- **Transcripts:** the depositions of Cotton, Robbie Tolan, Bobby Tolan and possibly Edwards are in the district court summary judgment record. **Not found free online.** There are no SCOTUS e-filings for a 2013 docket, and I could not check RECAP. Most likely obtainable only through PACER, or from the Fifth Circuit record on appeal. Certified if obtained. Length unknown.
- **Deposition vs other testimony:** mixed. Most of the conflicts rest on depositions; the mother's testimony and part of Tolan's come from the criminal trial transcript.
- **Missing:** every transcript. This is the cleanest court-identified conflict *between different witnesses* in this inventory, but its sources are not free.

## 3. United States v. Philip Morris USA, Inc.

- **Case:** United States v. Philip Morris USA, Inc., D.D.C., No. 99-cv-2496 (GK), Final Opinion Aug. 17, 2006, 449 F. Supp. 2d 1 (Judge Kessler).
- **Conflict:** Brown & Williamson lawyer J. Kendrick Wells vs whistleblower Jeffrey Wigand, about what happened to the 13-page draft minutes of the 1989 Vancouver research meeting.
- **Judicial document (opened, CAP):** Findings of Fact ¶ 3886, **449 F. Supp. 2d at 806**: "The Court does not credit the testimony of either J. Kendrick Wells or Jeffrey Wigand about what happened to the Vancouver conference minutes. Wells' testimony was simply not credible and Wigand's was unreliable, contradictory, and impeached on a number of points." The surrounding paragraphs cite "Wigand WD" by page:line (e.g. 41:9-18). The opinion also uses the page:line form (e.g. at 646) when it rejects a witness whose testimony documents contradicted.
- **Transcripts:**
  - Wigand's written direct testimony (opened as a HEAD check: 525 KB PDF): https://www.justice.gov/sites/default/files/civil/legacy/2014/09/11/Wigand_Written%20Direct%20Testimony_0.pdf (linked from DOJ's "Week 17" page). Official DOJ release of a court submission. Complete written direct; trial cross-examination not located.
  - Wells: **not located.** He was a defense witness, and DOJ's site appears to host mainly the United States' witnesses. Unverified.
  - Many older depositions of Wigand and of tobacco executives are in the UCSF Truth Tobacco Industry Documents archive (not checked).
- **Deposition vs other testimony:** written direct and trial testimony, not depositions. The finding is general, with no pinpoint to the contradicting lines.
- **Notes:** very large record. The opinion runs to 987 pages, so finding specific contradicting pairs would be labor-intensive.

## 4. Giuffre v. Maxwell

- **Case:** Giuffre v. Maxwell, S.D.N.Y., No. 1:15-cv-07433 (Sweet, later Preska). Defamation; settled in 2017.
- **Conflict:** Maxwell denied recruiting or abusing Giuffre (she reportedly called her "an absolute total liar"); Giuffre's deposition says the opposite. Party vs party.
- **Judicial document:** Judge Sweet's March 2017 opinion denying summary judgment (reported as 76 pages, heavily redacted), ordered unsealed after the Second Circuit's 2019 decision in Brown v. Maxwell (No. 18-2868). **Not located or opened; no pin cite.**
- **Transcripts:**
  - Maxwell deposition (Apr. 22, 2016): ECF 1137-13, filed Oct. 22, 2020, 465 pp. (redacted). https://free.law/pdf/gov.uscourts.nysd.447706.1137.13_4.pdf (from search results; not opened). Certified court filing, free through RECAP.
  - Giuffre deposition (May 2016): portions were reportedly released in the July 30, 2020 unsealing (47 documents). Exact URL **unverified**.
  - The RECAP docket exists and is free: I opened ECF 1332, https://storage.courtlistener.com/recap/gov.uscourts.nysd.447706/gov.uscourts.nysd.447706.1332.0.pdf, a 2024 unsealing cover letter.
- **Notes:** heavy redactions, names of non-parties ("Does"), and sexual-abuse content involving minors. Ethically and practically a poor first test case.

## 5. Georgia v. Trump: Willis disqualification order

- **Case:** State of Georgia v. Trump et al., Fulton County Superior Court, No. 23SC188947. Order on the motions to disqualify, March 15, 2024 (Judge Scott McAfee).
- **Conflict:** Robin Yeartie (who said the relationship began in 2019) and Terrence Bradley vs Fani Willis and Nathan Wade (who said 2022).
- **Judicial document:** press reports quote the order: "an odor of mendacity remains", and Bradley's "inconsistencies, demeanor, and generally non-responsive answers left far too brittle a foundation". **Order not opened; no pin cite.**
- **Transcripts:** evidentiary hearing of Feb. 15-16 and Mar. 1, 2024. Video is public; whether an official transcript is free online is **unverified**. Nathan Wade's divorce-case deposition exists, but its availability is unverified.
- **Notes:** hearing testimony, not depositions. Criminal case.

## 6. Epic Games v. Apple: contempt order

- **Case:** Epic Games, Inc. v. Apple Inc., N.D. Cal., No. 4:20-cv-05640-YGR. Order granting the motion to enforce the injunction / civil contempt, April 30, 2025 (80 pp.).
- **Conflict:** reported findings that VP of Finance Alex Roman's testimony about when Apple chose its 27% commission was "replete with misdirection and outright lies". The contradiction is mainly with contemporaneous documents (and with Phil Schiller's documented position).
- **Judicial document:** a DocumentCloud copy reported at https://s3.documentcloud.org/documents/25924283/epic-v-apple-contempt-order.pdf (**not opened**; pin cites unverified).
- **Transcripts:** evidentiary-hearing transcripts (2024-25), possibly on RECAP once the restriction period ended. **Unverified.**
- **Notes:** testimony vs documents, not two witnesses. Lower fit.

## 7. United States v. Bankman-Fried (criminal)

- **Case:** S.D.N.Y., No. 1:22-cr-00673 (LAK). Trial October-November 2023; sentenced March 28, 2024.
- **Conflict:** Bankman-Fried's trial testimony (that he did not know Alameda had spent FTX customer deposits until fall 2022, among other points) vs Caroline Ellison's testimony.
- **Judicial document:** Judge Kaplan's perjury findings at sentencing, reported in the press (three findings). The sentencing transcript was **not located or opened**.
- **Transcripts:** trial transcripts; a free source is unverified.
- **Notes:** criminal trial testimony, not depositions. Mentioned only because "Ellison" material may already be familiar to the project. I did not check the project, as instructed.

## 8. Rufo v. Simpson (checked as you asked)

- **Case:** Rufo v. Simpson, 86 Cal. App. 4th 573 (2001), Cal. Ct. App., 2d Dist., No. B112612, decided Jan. 26, 2001 (appeal from the 1997 civil verdict, L.A. Super. Ct.).
- **Finding (opened, CAP https://static.case.law/cal-app-4th/86/html/0573-01.html):** the opinion **never mentions Faye Resnick**. Its only reference to a deposition is at **86 Cal. App. 4th at 592-93**, quoting the plaintiffs' argument that "at his deposition, Simpson denied all of this conduct" (the June 1994 recital). That is an argument about relevance, not a court finding of conflicting testimony. Other discussion concerns Mark Fuhrman's former testimony (its exclusion), not conflicts between witnesses.
- **Transcripts:** Simpson and Resnick depositions as archive-derived HTML, as you noted (not re-checked).
- **Verdict:** **no judicial document identifies a conflict.** I did not check trial-court rulings, which are not online in CAP. Not recommended for "court-identified" ground truth.

## 9. United States v. Microsoft (checked; rejected)

- **Case:** D.D.C., No. 98-1232 (TPJ). Findings of Fact, Nov. 5, 1999.
- **Finding (opened, https://www.justice.gov/atr/us-v-microsoft-courts-findings-fact):** the Findings narrate events (e.g. ¶ 87, Rosen vs Reardon on the June 1995 Netscape meeting) but contain no transcript citations and no explicit credibility conflicts ("deposition": 0 hits; "contradict": 0).
- **Transcripts (opened index):** https://www.justice.gov/atr/cases/ms_depos.htm lists official DOJ PDFs of deposition excerpts as played or admitted in court (Gates in 8 parts; about 40 Microsoft and industry witnesses, e.g. /atr/cases/exhibits/1459.pdf). Written direct testimony is at /atr/us-v-microsoft-corporation-browser-and-middleware-direct-testimony.
- **Verdict:** an excellent free source of official transcripts, but with no court-identified conflict.

---

## Missing or blocked transcripts

- **Tolan v. Cotton:** the depositions of Cotton, Robbie Tolan, Bobby Tolan and Edwards were not found free. Probably PACER (S.D. Tex.) or the Fifth Circuit record on appeal. The district docket number is unverified.
- **Jones v. Clinton:** only the "publicly available portions" of Clinton's deposition are released. The exact PDF and page ranges of the Clinton and Lewinsky grand jury transcripts inside the 20-24 MB GPO volumes are unverified, and so is whether those PDFs have a text layer.
- **United States v. Philip Morris:** Wells's testimony was not located. Wigand's trial cross-examination was not located.
- **Giuffre v. Maxwell:** the summary judgment opinion and the Giuffre deposition were not located (both were reportedly unsealed). Heavy redactions.
- **Willis disqualification:** whether an official hearing transcript is online is unknown, and the order was not opened.
- **Epic v. Apple:** whether the hearing transcripts are free on RECAP is unknown, and the order was not opened.
- **Bankman-Fried:** the sentencing transcript and trial transcripts have no verified free source.
- **CourtListener search and API:** blocked for anonymous use (403). RECAP files can be fetched only by a known direct URL.

## Recommendation

1. **Jones v. Clinton (start here).** It is the only candidate where I opened the judicial document and confirmed the court quoting both sworn statements, with transcript page cites, and finding one "directly contradicted" the other ("intentionally false"). Both transcripts are official public-domain government prints, and both are fairly small (deposition about 205 pp., released portions only; grand jury about 150 pp.). The caveat: the court's finding is about **one witness in two sessions** (deposition vs grand jury), which is exactly the product's main use. For two different witnesses, the same official volumes add the Lewinsky and Currie grand jury transcripts, but that conflict comes from a congressional report, not a court. A practical first step is to locate the exact pages of Clinton's grand jury testimony in Senate Doc. 106-3 Vol. III and check the text layer.
2. **Tolan v. Cotton:** the best court-identified conflict between *different* witnesses, with record pin cites (572 U.S. at 657-59). Worth a PACER purchase or a records request if a cross-witness benchmark matters.
3. **United States v. Philip Morris:** a fallback. The finding is general and only one witness's testimony was located.

Not recommended: Rufo v. Simpson (no judicial finding), Microsoft (no finding), and Giuffre v. Maxwell (sensitive, opinion unverified).

## What I could not verify

- Every item marked "not opened" or "unverified" above: the Willis, Epic and Bankman-Fried orders and transcripts; the Giuffre v. Maxwell summary judgment opinion; the Tolan district docket and depositions; Wells's testimony.
- The CAP page numbers (1127-1130, 657-659, 806, 592-93) come from the page markers in CAP's HTML. They should be confirmed against the bound reporters.
- The internal page ranges of the large GPO PDFs were inferred from H. Rept. 105-830's cites, not opened.
