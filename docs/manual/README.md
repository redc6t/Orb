# User manual source

`orb-user-manual.html` is the source of the user manual. The PDF in the repository root (`Orb_User_Manual_v<version>.pdf`) is printed from it.

- `img/` holds the screenshots. They are taken from the demo (`make-demo.bat`, `start-orb.bat`, `start-simulator.bat`) in a 1600 x 1000 browser window at 1.5x scale.
- Mark anything added since the previous manual with `<span class="new">NEW</span>`, and update section 1.4 and Appendix C.
- Change the version in the `<title>`, the cover, the page footer (`@page` rule at the top of the file), section 3.1 and the feedback template.

## Print to PDF

Open the file in Chrome or Edge and print it to PDF (A4, margins *Default*, headers and footers off, background graphics on), or from a terminal:

```bash
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --no-pdf-header-footer --print-to-pdf="Orb_User_Manual_v2.2.19.pdf" "docs\manual\orb-user-manual.html"
```

Run it from the repository root, then delete the previous PDF and update the link in `README.md` and `.github/ISSUE_TEMPLATE/config.yml`.
