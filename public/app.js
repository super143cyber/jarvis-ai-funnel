/* ================================================================
   JARVIS AI — Frontend Application
   ================================================================ */

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Navbar scroll effect
  // ---------------------------------------------------------------
  const navbar = document.getElementById('navbar');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;
    if (scrollY > 40) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
    lastScroll = scrollY;
  });

  // ---------------------------------------------------------------
  // Mobile menu
  // ---------------------------------------------------------------
  const mobileBtn = document.getElementById('mobileMenuBtn');
  const navLinks = document.querySelector('.nav-links');

  if (mobileBtn) {
    mobileBtn.addEventListener('click', () => {
      navLinks.classList.toggle('mobile-open');
      mobileBtn.classList.toggle('active');
    });

    // Close mobile menu on link click
    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('mobile-open');
        mobileBtn.classList.remove('active');
      });
    });
  }

  // ---------------------------------------------------------------
  // Intersection Observer for reveal animations
  // ---------------------------------------------------------------
  const revealElements = document.querySelectorAll(
    '.feature-card, .step-card, .industry-card, .pricing-card, .cta-card'
  );

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal', 'visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  revealElements.forEach((el) => {
    el.classList.add('reveal');
    observer.observe(el);
  });

  // ---------------------------------------------------------------
  // Particle background
  // ---------------------------------------------------------------
  const particlesContainer = document.getElementById('particles');

  function createParticles() {
    if (!particlesContainer) return;
    const count = window.innerWidth < 768 ? 20 : 40;

    for (let i = 0; i < count; i++) {
      const particle = document.createElement('div');
      particle.style.cssText = `
        position: absolute;
        width: ${Math.random() * 2 + 1}px;
        height: ${Math.random() * 2 + 1}px;
        background: rgba(0, 212, 255, ${Math.random() * 0.3 + 0.1});
        border-radius: 50%;
        left: ${Math.random() * 100}%;
        top: ${Math.random() * 100}%;
        animation: float-particle ${Math.random() * 10 + 10}s linear infinite;
        animation-delay: ${Math.random() * -20}s;
      `;
      particlesContainer.appendChild(particle);
    }

    // Add keyframes for particle animation
    if (!document.getElementById('particle-styles')) {
      const style = document.createElement('style');
      style.id = 'particle-styles';
      style.textContent = `
        @keyframes float-particle {
          0% { transform: translateY(0) translateX(0); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(-100vh) translateX(${Math.random() > 0.5 ? '' : '-'}${Math.random() * 100}px); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  createParticles();

  // ---------------------------------------------------------------
  // Demo form submission
  // ---------------------------------------------------------------
  const demoForm = document.getElementById('demoForm');
  const phoneInput = document.getElementById('phoneInput');
  const demoBtn = document.getElementById('demoBtn');
  const formMessage = document.getElementById('formMessage');

  if (demoForm) {
    demoForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const phone = phoneInput.value.trim();
      if (!phone || phone.length < 7) {
        showFormMessage('Please enter a valid phone number.', 'error');
        return;
      }

      // Show loading state
      setButtonLoading(demoBtn, true);

      try {
        const res = await fetch('/api/demo-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        });

        const data = await res.json();

        if (data.success) {
          showFormMessage(
            'Demo request received! You will receive a call shortly.',
            'success'
          );
          phoneInput.value = '';
        } else {
          showFormMessage(data.error || 'Something went wrong. Please try again.', 'error');
        }
      } catch (err) {
        console.error('Demo request error:', err);
        showFormMessage('Network error. Please try again.', 'error');
      } finally {
        setButtonLoading(demoBtn, false);
      }
    });
  }

  function showFormMessage(text, type) {
    formMessage.textContent = text;
    formMessage.className = `form-message ${type}`;
    setTimeout(() => {
      formMessage.textContent = '';
      formMessage.className = 'form-message';
    }, 6000);
  }

  function setButtonLoading(btn, loading) {
    const textEl = btn.querySelector('.btn-text');
    const loaderEl = btn.querySelector('.btn-loader');
    if (loading) {
      textEl.style.display = 'none';
      loaderEl.style.display = 'inline-flex';
      btn.disabled = true;
    } else {
      textEl.style.display = 'inline';
      loaderEl.style.display = 'none';
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------
  // Checkout modal
  // ---------------------------------------------------------------
  const checkoutModal = document.getElementById('checkoutModal');
  const checkoutForm = document.getElementById('checkoutForm');
  const checkoutSubmitBtn = document.getElementById('checkoutSubmitBtn');

  window.openCheckout = function () {
    checkoutModal.classList.add('active');
    document.body.style.overflow = 'hidden';
  };

  window.closeCheckoutModal = function () {
    checkoutModal.classList.remove('active');
    document.body.style.overflow = '';
  };

  // Close modal on overlay click
  if (checkoutModal) {
    checkoutModal.addEventListener('click', (e) => {
      if (e.target === checkoutModal) {
        window.closeCheckoutModal();
      }
    });
  }

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.closeCheckoutModal();
    }
  });

  // Checkout form submission
  if (checkoutForm) {
    checkoutForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('checkoutName').value.trim();
      const email = document.getElementById('checkoutEmail').value.trim();
      const phone = document.getElementById('checkoutPhone').value.trim();
      const business = document.getElementById('checkoutBusiness').value.trim();

      if (!name || !email || !phone || !business) {
        alert('Please fill in all fields.');
        return;
      }

      setButtonLoading(checkoutSubmitBtn, true);

      try {
        const res = await fetch('/api/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, phone, business }),
        });

        const data = await res.json();

        if (data.success && data.url) {
          // Redirect to Stripe Checkout
          window.location.href = data.url;
        } else {
          alert(data.error || 'Could not create checkout session. Please try again.');
        }
      } catch (err) {
        console.error('Checkout error:', err);
        alert('Network error. Please try again.');
      } finally {
        setButtonLoading(checkoutSubmitBtn, false);
      }
    });
  }

  // ---------------------------------------------------------------
  // Smooth scroll for anchor links
  // ---------------------------------------------------------------
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        const offset = 80; // navbar height
        const top = target.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  });

})();
