// Injected by record.mjs before every document loads. Keep this file
// dependency-free: Playwright evaluates it as a plain browser script.
//
// The overlay is recorded as part of the page, so captions are burned into the
// video at exactly the moment they are shown. It deliberately uses inline
// styles and a host under <html> so application CSS and re-renders cannot
// remove or restyle it.
;(() => {
  if (window.top !== window) {
    return
  }

  const HOST_ID = "slipmem-tour-overlay"
  if (document.getElementById(HOST_ID)) {
    return
  }

  const style = document.createElement("style")
  style.textContent = `
    #${HOST_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    #${HOST_ID} [data-caption] {
      position: absolute;
      left: 50%;
      bottom: 36px;
      box-sizing: border-box;
      width: min(88%, 1100px);
      padding: 20px 28px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      background: rgba(17, 17, 17, 0.88);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
      color: #ffffff;
      font-size: clamp(20px, 2vw, 30px);
      font-weight: 500;
      line-height: 1.35;
      text-align: center;
      text-wrap: balance;
      opacity: 0;
      transform: translate(-50%, 8px);
      transition: opacity 180ms ease, transform 180ms ease;
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
    }
    #${HOST_ID} [data-caption][data-visible="true"] {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    #${HOST_ID} [data-cursor] {
      position: fixed;
      left: 0;
      top: 0;
      box-sizing: border-box;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(0, 0, 0, 0.75);
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.95);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      opacity: 0;
      transform: translate(-50%, -50%);
      transition: opacity 150ms ease;
    }
    #${HOST_ID} [data-cursor][data-visible="true"] {
      opacity: 1;
    }
    #${HOST_ID} [data-click] {
      position: fixed;
      left: 0;
      top: 0;
      box-sizing: border-box;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.95);
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
      opacity: 0;
      transform: translate(-50%, -50%) scale(1);
    }
    #${HOST_ID} [data-click][data-active="true"] {
      animation: slipmem-tour-click 480ms ease-out forwards;
    }
    @keyframes slipmem-tour-click {
      from {
        opacity: 0.9;
        transform: translate(-50%, -50%) scale(1);
      }
      to {
        opacity: 0;
        transform: translate(-50%, -50%) scale(2.8);
      }
    }
  `

  const host = document.createElement("div")
  host.id = HOST_ID
  host.setAttribute("aria-hidden", "true")
  host.innerHTML = `
    <div data-caption data-visible="false"></div>
    <div data-cursor data-visible="false"></div>
    <div data-click data-active="false"></div>
  `

  const append = () => {
    document.documentElement.append(host, style)
  }
  if (document.documentElement) {
    append()
  } else {
    document.addEventListener("DOMContentLoaded", append, { once: true })
  }

  const caption = host.querySelector("[data-caption]")
  const cursor = host.querySelector("[data-cursor]")
  const click = host.querySelector("[data-click]")

  window.__slipmemTourCaption = (text) => {
    caption.textContent = text ?? ""
    caption.dataset.visible = text ? "true" : "false"
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      cursor.style.left = `${event.clientX}px`
      cursor.style.top = `${event.clientY}px`
      cursor.dataset.visible = "true"
    },
    { capture: true, passive: true },
  )

  document.addEventListener(
    "pointerdown",
    (event) => {
      cursor.style.left = `${event.clientX}px`
      cursor.style.top = `${event.clientY}px`
      cursor.dataset.visible = "true"

      click.style.left = `${event.clientX}px`
      click.style.top = `${event.clientY}px`
      click.dataset.active = "false"
      // Force a style flush so repeated clicks restart the animation.
      void click.offsetWidth
      click.dataset.active = "true"
      window.setTimeout(() => {
        click.dataset.active = "false"
      }, 500)
    },
    { capture: true, passive: true },
  )
})()
