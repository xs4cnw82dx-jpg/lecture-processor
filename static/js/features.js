    /* -- Firebase auth detection for nav -- */
    var firebaseConfig={apiKey:"AIzaSyBAAeEUCPNvP5qnqpP3M6HnFZ6vaaijUvM",authDomain:"lecture-processor-cdff6.firebaseapp.com",projectId:"lecture-processor-cdff6",storageBucket:"lecture-processor-cdff6.firebasestorage.app",messagingSenderId:"374793454161",appId:"1:374793454161:web:c68b21590e9a1fafa32e70"};
    firebase.initializeApp(firebaseConfig);
    var auth=firebase.auth();
    var topbarUtils=window.LectureProcessorTopbar||{};
    var navAuthBtn=document.getElementById('nav-auth-btn');
    var navAuthLabel=document.getElementById('nav-auth-label');

    if(topbarUtils.bindAuthCta){
      topbarUtils.bindAuthCta(auth,{
        labelEl:navAuthLabel,
        linkEl:navAuthBtn,
        signedInText:'Dashboard',
        signedOutText:'Sign In',
        signedInHref:'/dashboard',
        signedOutHref:'/dashboard'
      });
    }else{
      auth.onAuthStateChanged(function(user){
        if(user){
          navAuthLabel.textContent='Dashboard';
          navAuthBtn.href='/dashboard';
        }else{
          navAuthLabel.textContent='Sign In';
          navAuthBtn.href='/dashboard';
        }
      });
    }

    /* -- Time savings calculator -- */
    var calcLectures=document.getElementById('calc-lectures');
    var calcWeeks=document.getElementById('calc-weeks');
    var calcMinutes=document.getElementById('calc-minutes');
    var calcLecturesVal=document.getElementById('calc-lectures-val');
    var calcWeeksVal=document.getElementById('calc-weeks-val');
    var calcMinutesVal=document.getElementById('calc-minutes-val');
    var calcManual=document.getElementById('calc-manual');
    var calcLp=document.getElementById('calc-lp');
    var calcSaved=document.getElementById('calc-saved');

    function updateCalc(){
      var lectures=parseInt(calcLectures.value,10);
      var weeks=parseInt(calcWeeks.value,10);
      var minutes=parseInt(calcMinutes.value,10);
      calcLecturesVal.textContent=String(lectures);
      calcWeeksVal.textContent=String(weeks);
      calcMinutesVal.textContent=String(minutes);

      var totalLectures=lectures*weeks;
      var manualHours=Math.round((totalLectures*minutes)/60);
      // LectureProcessor estimate: ~3 min upload + ~2 min review per lecture
      var lpMinutesPerLecture=5;
      var lpHours=Math.round((totalLectures*lpMinutesPerLecture)/60);
      var saved=Math.max(0,manualHours-lpHours);

      calcManual.textContent=manualHours+'h';
      calcLp.textContent=lpHours+'h';
      calcSaved.textContent=saved+'h';
    }

    calcLectures.addEventListener('input',updateCalc);
    calcWeeks.addEventListener('input',updateCalc);
    calcMinutes.addEventListener('input',updateCalc);
    updateCalc();

    /* -- Scroll reveal animations -- */
    var revealElements=document.querySelectorAll('.reveal');

    function checkReveal(){
      var windowHeight=window.innerHeight;
      var triggerPoint=windowHeight*0.88;
      for(var i=0;i<revealElements.length;i++){
        var el=revealElements[i];
        var rect=el.getBoundingClientRect();
        if(rect.top<triggerPoint){
          el.classList.add('visible');
        }
      }
    }

    window.addEventListener('scroll',checkReveal,{passive:true});
    window.addEventListener('resize',checkReveal,{passive:true});
    // Initial check on load
    checkReveal();
    // Delayed check for elements that might be above fold
    setTimeout(checkReveal,100);

    /* -- Smooth scroll for anchor links -- */
    document.querySelectorAll('a[href^="#"]').forEach(function(link){
      link.addEventListener('click',function(e){
        var targetId=link.getAttribute('href');
        if(targetId.length<=1)return;
        var target=document.querySelector(targetId);
        if(target){
          e.preventDefault();
          var navHeight=64;
          var targetPosition=target.getBoundingClientRect().top+window.pageYOffset-navHeight;
          window.scrollTo({top:targetPosition,behavior:'smooth'});
        }
      });
    });
